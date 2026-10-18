# pi-ollama

Auto-discovers models from a running local Ollama server and registers them as the `ollama` provider in pi.

## Installation

### From Source

```bash
git clone https://github.com/agpenton/pi-ollama ~/code/pi-ollama
pi -e ~/code/pi-ollama/index.ts
```

Or install globally:

```bash
pi install github.com/agpenton/pi-ollama
```

### Prerequisites

- **Ollama**: A running Ollama server, available at `http://localhost:11434` by default.
- **pi**: The pi coding agent must be installed and running.

The extension uses Ollama's native `/api/*` endpoints for discovery and Ollama's OpenAI-compatible `/v1` endpoint for model requests.

## Usage

Once installed, you can interact with the extension via pi commands:

### List Available Models

```bash
/model
```

This refreshes the provider and discovers all models returned by Ollama's `/api/tags` endpoint.

If pi was started before installing or updating the extension, restart pi or run `/reload` first.

### Select a Model

Use `/model`, search for `ollama`, and select one of the discovered local models.

### Check Ollama Version

```bash
/ollama-version
```

Displays the version of the Ollama server.

Running `/model` also refreshes model discovery. There is no separate `/refresh-model` command.

## Configuration

### Environment Variables

- `OLLAMA_BASE_URL` - Base URL of the Ollama server (default: `http://localhost:11434`)
- `OLLAMA_API_KEY` - API key for authentication (default: `no-key`)

### Provider Settings

The extension automatically registers discovered models under the `ollama` provider. Configure a different Ollama server with:

```bash
export OLLAMA_BASE_URL=http://your-ollama-server:11434
pi
```

`OLLAMA_BASE_URL` should point to the Ollama server root, without `/api` or `/v1`. The extension uses `/api/tags` and `/api/show` for discovery, and appends `/v1` for OpenAI-compatible model requests.

## Architecture

- **Provider ID**: `ollama`
- **Discovery base URL**: `http://localhost:11434` (configurable via `OLLAMA_BASE_URL`)
- **Request base URL**: `http://localhost:11434/v1`
- **API type**: `openai-completions`
- **Ollama endpoints**:
  - `GET /api/tags` — list installed models
  - `GET /api/version` — report the Ollama version via `/ollama-version`
  - `POST /api/show` — inspect a selected model
- **OpenAI-compatible endpoint**: `/v1` — used by pi for model requests

## Troubleshooting

- **No models found**: Confirm `curl http://localhost:11434/api/tags` returns a non-empty `models` array, then restart pi or run `/reload`.
- **Connection refused**: Verify Ollama is running and that `OLLAMA_BASE_URL` points to the correct server.
- **Models are listed but requests fail**: Ensure the configured Ollama server supports the OpenAI-compatible `/v1` API.
- **Remote Ollama server**: Set `OLLAMA_BASE_URL` before starting pi; do not include `/api` or `/v1` in the value.
- **Session replacement**: The extension handles stale context errors gracefully.

## License

MIT
