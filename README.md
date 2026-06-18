# ITS: Integrated Telemetry System

A plugin-driven telemetry platform.

## Quickstart

Install the two toolchains (Windows):

```
winget install astral-sh.uv 
winget install pnpm.pnpm
```

macOS/Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh` for uv, `curl -fsSL https://get.pnpm.io/install.sh | sh -` for pnpm.

*yeah i know doing installs with `| sh` is a shitty security hazard, cry abt it or check it urself*

Install ITS dependencies:
```
uv sync
pnpm install
```

This installs the `its` command into `.venv`. Activate it (or prefix commands with `uv run`):

```
.venv\Scripts\activate          # Windows
source .venv/bin/activate       # macOS/Linux
```

Build and run optimized server:
```
its start
```

Then open http://localhost (redirects to Vite on :5173 in dev).

## Other commands

Start the server with hot reload:

```
its dev
```


Run a single standalone plugin

```
its connect <plugin> [host] [--field=value ...]
```

List every stream

```
its streams
```

Check env:
```
its doctor
```
