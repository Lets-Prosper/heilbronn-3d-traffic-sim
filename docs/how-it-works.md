# StadtFluss — how it works

A 3D traffic simulation of the Karlsruher Straße × Theresienstraße area in Heilbronn.
It compares two ways of running the traffic lights on identical traffic:

- **A · Fixed loop**: lights on a fixed timer, like a conventional controller.
- **B · Smart control**: lights that react to how many cars are waiting (max-pressure control).

This document explains each part of the system, what every number on screen means and how it is
calculated, how far the results can be trusted, and what data would make them more accurate.

---

## 1. The big picture

```
 OpenStreetMap extract ──► road network (streets, lanes, speed limits, signals)
                                   │
 2023 city counts (CSV) ──► demand (cars per hour per turning movement)
                                   │
                                   ▼
             ┌──────────── traffic engine (pure TypeScript) ────────────┐
             │  sim A: fixed-loop lights      sim B: smart lights       │
             │  same seed, same arriving cars, stepped together 10×/s   │
             └──────────────────────────────────────────────────────────┘
                                   │
                                   ▼
          3D view (React Three Fiber) + metrics panel + demo sequence
```

Both simulations run **all the time, side by side**. They start from the same random seed and get
the same cars at the same moments, with the same routes and the same drivers. The only difference
is the traffic-light controller. The big toggle only chooses which of the two the 3D city
**shows**. That is why flipping it shows "the same cars, at the same moment, under the other
controller", and why the A-vs-B numbers are a fair comparison.

---

## 2. The city (road network)

**Source:** `public/data/heilbronn.geojson`, an OpenStreetMap export covering roughly 800 × 700 m
around the junction.

What is taken from it:

| OSM information | Used for |
|---|---|
| Drivable streets (`highway=primary/secondary/residential/…`) | Road graph. Parking aisles and driveways are excluded. |
| One-way tags | Direction of travel |
| `lanes`, `lanes:forward/backward` | Number of lanes per direction (default 1) |
| `maxspeed` | Speed limit (default 50 km/h in town) |
| `highway=traffic_signals` nodes | Where the lights are |
| Building footprints + `height` / `building:levels` | 3D buildings (default 9 m high if untagged) |

The road graph has 122 nodes and 194 directed edges (about 11.5 lane-direction km). An **edge**
is one stretch of road in one direction between two junctions.

**How it looks:** street layout, lane counts and building shapes are real. The look is stylised:
flat colours, box buildings, no textures, street names or landmarks.

---

## 3. Where the cars come from (demand)

### 3.1 The counting data

**Source:** `Zählstelle Karlsruher Straße_Theresienstraße_2023.csv`, the City of Heilbronn's
plausibility-checked hourly vehicle counts for 2023 (52,554 rows).

Each detector counts **one turning movement** at the junction:

| Detector | Approach | Movement |
|---|---|---|
| D1 | Theresienstraße from the north | right turn |
| D2 | Theresienstraße from the north | straight |
| D3 | Theresienstraße from the north | left turn |
| D4 | Karlsruher Straße from the east | right turn |
| D12 | Theresienstraße from the south | straight |
| D16 | Karlsruher Straße from the west | left turn |

Notes on reading the file:
- Timestamps mark the **end** of each hour: the row stamped `08:00` is the 07:00–08:00 count.
- About 2% of values are decimals with a comma (`10,1`). These are corrected values, and they are
  used as-is.
- The script `npm run derive-demand` turns the file into **average cars per hour for each detector
  and each hour of the day**, separately for weekdays and for all days. It saves these to
  `src/data/demand2023.json`, which the app loads; the 52k-row CSV never goes to the browser.

At 07:00–08:00 on weekdays (the busiest hour), the six detectors add up to **372 cars per hour**.

### 3.2 Turning the counts into cars on the map

Each movement becomes its own **stream of cars** with a fixed route:

1. Start at the nearest edge of the map that leads into that approach.
2. Drive to the junction and make the counted turn (for example, D1 turns right and leaves to the
   west).
3. Leave the junction and drive to the nearest edge of the map.

Cars in a stream arrive **at random times at the counted average rate** (a Poisson process). With
86 cars per hour you get 86 on average, but not one every 42 seconds exactly.

### 3.3 Traffic that is not from the data

- **Background traffic:** 0.004 cars/s (about 14 per hour) enters at each of the 26 map entry
  points and drives to a random exit by the quickest route. That is about 374 cars/hour across the
  whole map. It keeps the rest of the city alive but **is not calibrated**: it is a guess.
- **Assumed through traffic (optional):** the counts do **not** include cars going straight along
  Karlsruher Straße, which is the main road. The HUD can add +300 or +600 cars/hour per direction.
  This is an **assumption**, clearly labelled, and off by default.
- **Demand multiplier:** "counts 2×" doubles every counted stream, to show behaviour at
  higher-than-average demand.

**The demo preset uses counts ×2 plus 300 assumed through cars per hour per direction.** Without
this extra traffic the improvement still shows up in the numbers, but the queues on screen are
short.

---

## 4. How cars drive (the engine)

The engine is pure TypeScript with no graphics (`src/engine/`). It advances in fixed steps of
**0.1 s (10 times per simulated second)**. It is **deterministic**: the same seed always gives
exactly the same result, which the tests check.

### 4.1 Car-following: Intelligent Driver Model (IDM)

Every 0.1 s each car chooses an acceleration from three things: its own speed, its desired speed,
and the gap and closing speed to whatever is ahead (a car or a red light).

| Parameter | Value | Meaning |
|---|---|---|
| Max acceleration | 1.5 m/s² | Comfortable pull-away |
| Comfortable braking | 2.0 m/s² | Normal braking |
| Jam gap | 2.0 m | Bumper-to-bumper distance when stopped |
| Time headway | 1.2 s | Following distance at speed |
| Car length | 4.5 m | |
| Desired speed | speed limit × random 0.9–1.1 | Each driver is slightly different |

### 4.2 Routes, lanes and traffic lights

- **Routing:** the quickest route at free-flow speed (length ÷ speed limit), with no U-turns.
- **Lanes:** a car entering a road picks the lane with the most free space. **There are no lane
  changes after that.**
- **Red lights:** a red or amber light acts like a stopped car at the stop line, so cars brake and
  queue behind it. If a car can't stop comfortably when the light turns amber (it would need more
  than 4.5 m/s² of braking), it carries on, as a real driver would.
- **Junctions without lights:** cars only check that there is space on the next road. They do not
  give way to cross traffic at these junctions; this is a simplification.

### 4.3 How the lights are grouped

In OpenStreetMap the lights are mapped on the approach roads, 10–40 m before the junction, not on
the junction itself. The engine groups all signal points within 60 m of each other into one
**intersection**. Then:

- Only traffic **heading into** the intersection gets a stop line. Traffic leaving it is not
  stopped.
- Each approach is assigned to one of two **phase groups** by its direction:
  **north–south** or **east–west**. At the main junction, Theresienstraße is north–south and
  Karlsruher Straße is east–west.

---

## 5. The two controllers

### Mode A — Fixed loop (`controllers/fixedCycle.ts`)

```
[N–S green 30 s][amber 3 s][all red 2 s][E–W green 30 s][amber 3 s][all red 2 s] → repeat (70 s)
```

All intersections run this same timetable, regardless of how many cars are waiting.

### Mode B — Smart control / max-pressure (`controllers/maxPressure.ts`)

Every 2 seconds, each intersection compares its two phase groups:

```
pressure(approach) = cars on the approach road
                     − average cars on the roads that approach feeds into
pressure(phase)    = sum of pressure over that phase's approaches
```

- The phase with the **higher pressure** gets green. "Lots of cars waiting, and room for them to
  go" means high pressure. If the exit roads are already full, pressure is low, so the controller
  doesn't send cars into a jam.
- Safety and stability rules:
  - every green lasts at least 6 s;
  - after 60 s it switches if the other side has any demand at all;
  - every switch includes 3 s amber and 2 s all-red.
- Intersections that only have one phase group, such as pedestrian crossings, keep the fixed loop
  in both modes. So A and B only differ where traffic streams actually compete.

**Is this AI or computer vision?** No. Max-pressure is a published traffic-control rule (Varaiya,
2013), not machine learning, and the simulation has no cameras. It needs **car counts per approach
road**, which is exactly what a camera-based detector at the junction would supply. An honest way
to present it is: *"adaptive control using live vehicle counts — the kind of data a computer-vision
detector would provide"*. A learned (reinforcement-learning) controller is a possible next step.

---

## 6. What each number means

All numbers in the metrics panel cover the **whole simulated map** since the last restart, not
just the main junction. Column A and column B are measured at the same simulated time on identical
traffic. **Δ** is the change from A to B as a percentage: green means B is better, orange means B
is worse.

A car counts as **stopped** when it is slower than **0.5 m/s** (1.8 km/h).

| Stat | Meaning | How it is calculated |
|---|---|---|
| **Avg wait** (s) | Average time a car spent stopped during its trip | For every car that has **finished** its trip: add up its stopped time, then average over those cars. Cars still driving are not included yet. |
| **Throughput** (veh/h) | How fast cars are completing trips | Number of cars that reached their exit ÷ simulated time so far, scaled to one hour. |
| **Mean queue** (veh) | How many cars are standing still on average | Count stopped cars on the whole map every 0.1 s, then average over the run. |
| **Stops** | Number of times a car came to a halt | Counted each time a car drops below 0.5 m/s, after it had been going faster than 2 m/s since its last stop. Creeping forward in a queue doesn't count as a new stop. |
| **CO₂** (kg) | Estimated extra CO₂ from idling and restarting | Idle part + stop part (below) |
| **NOₓ** (g) | Estimated NOₓ from idling | Idle part only (below) |

### Emission formulas (`src/engine/metrics/emissions.ts`)

**Idle part:** total idle time is the sum, over every car, of its seconds spent stopped.

```
CO₂ idle = total idle seconds × 17 g/min ÷ 60
NOₓ idle = total idle seconds × 0.07 g/min ÷ 60
```

- Both rates come from TRL's idling study (PPR987): about 17 g CO₂/min for small and family cars,
  and up to 0.07 g NOₓ/min for a large diesel car. NOₓ is therefore an **upper estimate**.
- Cross-check: DOE/Argonne measured about 0.16 US gallons per hour of fuel at idle for a 2.0 L car.
  With EPA's 8,887 g CO₂ per gallon, that is about 24 g/min, the same order of magnitude.

**Stop part:** this is **calculated from physics, not a published factor.** Each stop throws away
the car's moving energy, and the engine has to burn fuel to get it back:

```
energy  = ½ × 1,400 kg × (peak speed before the stop)²
fuel    = energy ÷ (20% engine efficiency × 32 MJ per litre of petrol)
CO₂     = fuel × 2,348 g per litre   (EPA 8,887 g/gal ÷ 3.785 L/gal)
```

A stop from 50 km/h works out to about **50 g CO₂**. There is no NOₓ term for stops.

**What these emission figures are not:** they are not a full emissions inventory. Driving at speed
also emits a lot, and that part is the same in A and B, so it is left out. The figures show
**how much of the waiting-related emissions smart control avoids**.

### Other numbers

- **Clock** (top bar): simulated time since the restart.
- **"Stopped now" / 60-second queue:** internal metrics. `queueNow` and `queueRecent` exist in the
  engine; the current panel shows the run-average mean queue.
- **Worst junction:** when the app loads, a hidden 10-minute fixed-loop run measures stopped cars
  on every intersection's approach roads, once per simulated second. The intersection with the
  highest total is the camera target. With the current data this is Karlsruher Str. ×
  Theresienstraße.

---

## 7. How to read the results

Typical results, one simulated hour, seed 1 (`npm run compare`):

| Demand | Avg wait A → B | Mean queue A → B |
|---|---|---|
| Counted only, 1× | 14.6 s → 4.2 s | 2.9 → 0.8 |
| Counted only, 3× | 15.5 s → 5.8 s | 6.2 → 2.3 |
| Counted + 300 assumed through, 3× | 42.3 s → 22.1 s | 37.7 → 19.6 |

How to talk about these results:
- Smart control reduces **waiting, queues, stops and idle emissions**. It does **not** reduce the
  amount of traffic: the same cars arrive in both modes.
- **Throughput** is often higher in B early in a run. That means trips finish sooner, not that more
  cars were served. Over a full hour both modes settle near the demand rate.
- **Avg wait** only counts finished trips. In the first minutes it is based on few cars and jumps
  around, so read it after a few simulated minutes.
- The size of the improvement depends on the **baseline**. Mode A is a simple 30/30 timer, but the
  real Heilbronn signals may already adapt to traffic. **Against the real signal plan the gain would
  very likely be smaller.** This is the most important caveat (see section 8).

---

## 8. Where it needs to improve

### Accuracy of the comparison (most important)
1. **The baseline is not Heilbronn's real signal timing.** The fixed loop is our own 30/30 s
   timetable. The real controllers may use different splits, coordination between junctions, or
   detector-actuated phases. This probably **overstates** the gain.
2. **Two phase groups only.** Real junctions have protected left turns, slip lanes with their own
   signals, and pedestrian phases. None of these are modelled.
3. **No conflicts inside junctions.** Cars from crossing streams don't block each other inside the
   junction, and there is no give-way rule at junctions without lights.
4. **No lane changes or dedicated turn lanes.** A car picks a lane when it enters a road and stays
   in it, so one car turning can't hold up a lane the way it would in reality.
5. **Smart control sees perfectly.** It knows the exact car count on every road. A real camera
   system has detection errors, delays and limited range.
6. **One random seed.** Results should be averaged over many seeds and reported with a range, not
   one number.
7. **Not validated.** The simulation has not been checked against real queue lengths or travel
   times at this junction.

### Demand
8. Only 6 movements are counted. Karlsruher Straße through traffic and the other turns are missing.
9. Hourly averages only. Real peaks within the hour, platoons arriving from upstream lights, and
   day-to-day variation are lost. Public holidays are included in the weekday average.
10. All vehicles are identical cars: no trucks, buses, bikes or pedestrians.
11. Background traffic elsewhere on the map is a guess.

### Emissions
12. Idle rates come from a UK study, not the German fleet. NOₓ uses an upper-bound diesel rate.
    Driving emissions depend on speed and acceleration, which is not modelled.

### Presentation
13. The city is recognisable from its layout but not dressed: no street names, landmarks or
    textures.
14. "Smart control" should not be called AI or computer vision until it actually uses one (see
    section 5).

---

## 9. Data we need for better accuracy

Ordered by how much each item would improve accuracy:

| # | Data | Likely source | What it fixes |
|---|---|---|---|
| 1 | **Real signal timing plans and controller logic** for the area's junctions: phases, green times, cycle length, coordination offsets, actuation rules | Stadt Heilbronn traffic engineering office | A realistic baseline (improvement 1) |
| 2 | **Complete turning counts** for every approach and movement at the junction, including Karlsruher Straße straight-through, ideally in **15-minute** intervals | Additional detectors, or a video count | Real demand on the main road; peaks within the hour |
| 3 | **Counts at the neighbouring signalised junctions** | City detector network | Calibrated background traffic; arrival platoons |
| 4 | **Measured queue lengths and travel times** for validation | Video at the junction, floating-car / probe data (navigation providers), Bluetooth/Wi-Fi travel-time sensors | Proof that the simulation behaves like the real junction |
| 5 | **Lane-level geometry:** turn lanes, stop-line positions, slip-lane signals | City signal and road-marking plans, or high-resolution aerial photos | Turn lanes, lane blocking, correct storage space |
| 6 | **Vehicle classes:** cars, vans, trucks, buses; bus routes and timetables | Classified counts; local bus operator timetable data (GTFS) | Truck/bus behaviour, bus priority |
| 7 | **Pedestrian and cyclist volumes and crossing phases** | City counts, signal plans | Realistic phase constraints |
| 8 | **Fleet composition and emission factors** (fuel, Euro class) | German vehicle-registration statistics (KBA); HBEFA emission factors | Credible, Germany-specific CO₂/NOₓ |
| 9 | **Camera / detector performance data**, if presenting a computer-vision approach | Pilot recordings with ground-truth counts | Realistic sensor noise and delay for the smart controller |
| 10 | **Origin–destination patterns** | Household travel survey; mobile-network OD data | Realistic routes for background traffic |

The single most valuable request is **item 1 together with item 2**: the real signal plans plus full
turning counts. With those, the A-vs-B comparison would be "today's real lights vs smart lights on
measured traffic", and the result could be defended.

---

## 10. Where things live in the code

| Area | Files |
|---|---|
| Count parsing, profiles | `src/data/counts.ts`, `scripts/derive-demand.ts`, `src/data/demand2023.json` |
| Scenario (movements → routes) | `src/data/scenario.ts` |
| Road network, routing | `src/engine/network/` |
| Car-following (IDM) | `src/engine/models/index.ts` |
| Simulation loop, spawning | `src/engine/engine.ts` |
| Signal grouping, controllers | `src/engine/controllers/` |
| Metrics, emissions | `src/engine/metrics/` |
| A/B lockstep, demo sequence | `src/state/simStore.ts` |
| 3D scene, cars, lights, camera | `src/render/` |
| HUD, toggle, metrics panel, captions | `src/ui/` |
| Headless A/B comparison | `scripts/compare-controllers.ts` (`npm run compare`) |

Run locally: `npm install`, then `npm run dev`, then open `/?demo` for the automatic before/after
sequence. Run the tests with `npm test`.
