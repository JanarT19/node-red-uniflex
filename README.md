# Uniflex Nodes for Node-RED

Custom Node-RED nodes for **Uniflex Systems** automation controllers: data streams, heating and cooling, energy, lighting, pumps, sauna, scheduling helpers, and utilities.

**npm:** `@janart19/node-red-uniflex`

## Features

- Query and write data stream values on Uniflex controllers
- SQL calendar, security, price/weather/holiday fetchers, and diagram helpers
- Heating and MPC (floor/room/house), heat pump and gas control, tanks, forecasts, safety
- Cooling (IDU, Thermokon, Perton), inverter / energy management
- Lighting, sauna, pumps / level control, ventilation, market-plan processing
- Utilities: averaging, logic, PID, PWM tickers, arithmetics, flow analysis, and more
- Support for multiple controllers

## Requirements

- Node-RED ≥ 4.0.0
- Node.js ≥ 16
- Access to a Uniflex automation controller (for controller-backed nodes)

## Important Note

This package is under active development and may include bugs. Feedback is welcome.

## Installation

### From Node-RED Palette Manager

1. Open Node-RED editor
2. Go to **Menu → Manage palette → Install**
3. Search for `@janart19/node-red-uniflex`
4. Click **Install**

### From Command Line

Run in your Node-RED user directory (typically `~/.node-red`):

```bash
npm install @janart19/node-red-uniflex
```

## Quick Start

### 1. Configure a Controller

- Add any `uniflex-*` node to your flow
- Open the node's configuration dialog
- Click the pencil icon next to "Controller"
- Enter your Uniflex controller's connection details (IP, port)
- Click "Add"

### 2. Query Data Streams

- Add a `uniflex-query-data-streams` node
- Select your controller configuration
- Connect an inject node to trigger queries
- Connect a debug node to see output
- Deploy and test

### 3. Build Domain Logic

- Use heating / cooling / pump / energy nodes for plant control
- Use calendar and price fetchers with `uniflex-sql-calendar` for schedules and tariffs
- Add utils (`uniflex-averager`, `uniflex-boolean-logic`, `uniflex-pid-controller`, …) as needed

## Available nodes

Registered in `package.json` (palette categories are set per node).

### Core

| Type                                 | Role                         |
| ------------------------------------ | ---------------------------- |
| `uniflex-controller`                 | Controller configuration     |
| `uniflex-query-data-streams`         | Query real-time data streams |
| `uniflex-query-external-connections` | Query external connections   |
| `uniflex-read-data-streams`          | Read / parse stream values   |
| `uniflex-write-data-streams`         | Write stream values          |
| `uniflex-sql-calendar`               | Calendar / scheduling        |
| `uniflex-security`                   | Auth / security              |
| `uniflex-price-fetcher-electricity`  | Electricity price fetch      |
| `uniflex-price-fetcher-gas`          | Gas price fetch              |
| `uniflex-holidays-fetcher`           | Holidays fetch               |
| `uniflex-openweather-fetcher`        | OpenWeather fetch            |
| `uniflex-diagram-creator`            | Diagram creation             |
| `uniflex-cal2datastream`             | Calendar → data stream       |

### Heating

| Type                            | Role                     |
| ------------------------------- | ------------------------ |
| `uniflex-heating-config`        | Heating configuration    |
| `uniflex-floor-loop`            | Floor heating loop       |
| `uniflex-room-loop`             | Room heating coordinator |
| `uniflex-mpc-floor`             | Floor MPC                |
| `uniflex-mpc-floor-advanced`    | Advanced floor MPC       |
| `uniflex-mpc-room`              | Room MPC                 |
| `uniflex-mpc-room-advanced`     | Advanced room MPC        |
| `uniflex-mpc-house`             | House-level MPC          |
| `uniflex-collector-supervisor`  | Collector supervision    |
| `uniflex-loop-supervisor`       | Multi-loop supervision   |
| `uniflex-gas-control`           | Gas boiler control       |
| `uniflex-hp-control`            | Heat pump control        |
| `uniflex-gas-watchdog`          | Gas watchdog             |
| `uniflex-hp-watchdog`           | Heat pump watchdog       |
| `uniflex-hp-error-manager`      | HP error handling        |
| `uniflex-immergas-control`      | Immergas control         |
| `uniflex-tank-control`          | Tank control             |
| `uniflex-thermal-model-config`  | Thermal model config     |
| `uniflex-state-observer`        | State observer           |
| `uniflex-safety-interlock`      | Safety interlock         |
| `uniflex-circulation-control`   | Circulation control      |
| `uniflex-circ-pump-control`     | Circulation pump control |
| `uniflex-heating-curve`         | Heating curve            |
| `uniflex-heater-setpoint-clamp` | Setpoint clamp           |
| `uniflex-heating-enable-merge`  | Enable merge             |
| `uniflex-forecast-publisher`    | Forecast publish         |
| `uniflex-sun-handler`           | Sun / solar handling     |
| `uniflex-price-handler`         | Price handling           |

### Cooling

| Type                            | Role                      |
| ------------------------------- | ------------------------- |
| `uniflex-cooling-config`        | Cooling configuration     |
| `uniflex-idu-cooling-control`   | IDU cooling control       |
| `uniflex-idu-gateway-monitor`   | IDU gateway monitor       |
| `uniflex-thermokon-flat`        | Thermokon flat            |

### Energy

| Type                                   | Role                                    |
| -------------------------------------- | --------------------------------------- |
| `uniflex-inverter-control`             | Inverter power management               |
| `uniflex-inverter-control-dual-limits` | Dual-limits / grid-interactive inverter |

### Lighting, comfort, pumps, ventilation, market

| Type                           | Role                     |
| ------------------------------ | ------------------------ |
| `uniflex-lamp-control`         | Lamp automation          |
| `uniflex-sauna-control`        | Sauna control            |
| `uniflex-sauna-scheduler`      | Sauna scheduling         |
| `uniflex-pump`                 | Pump instance control    |
| `uniflex-level-controller`     | Multi-pump level control |
| `uniflex-cabinet-heater`       | Cabinet heater control   |

### Utils

| Type                      | Role                  |
| ------------------------- | --------------------- |
| `uniflex-averager`        | Value averaging       |
| `uniflex-averager-gated`  | Gated averaging       |
| `uniflex-boolean-logic`   | Boolean logic         |
| `uniflex-topic-logic`     | Topic-based logic     |
| `uniflex-value-converter` | Value conversion      |
| `uniflex-comparator`      | Comparison            |
| `uniflex-arithmetics`     | Arithmetic ops        |
| `uniflex-pid-controller`  | PID control           |
| `uniflex-clock-ticker`    | PWM / clock ticker    |
| `uniflex-manual-ticker`   | Manual PWM trigger    |
| `uniflex-triple-status`   | Triple status display |
| `uniflex-measure-delay`   | Delay measurement     |
| `uniflex-flow-analyzer`   | Flow analysis         |
| `uniflex-flow-validator`  | Flow validation       |
| `uniflex-heating-power`   | Heating power helper  |

## Documentation

Select a node in the editor and open the **info** sidebar for full help text.
