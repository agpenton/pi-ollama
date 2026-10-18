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

- **Ollama Server**: A running Ollama server must be available at `http://localhost:11434` (default port).
- **Node.js**: Requires Node.js >= 14.x
- **pi**: The pi coding agent must be installed and running.

## Usage

Once installed, you can interact with the extension via pi commands:

### List Available Models

```bash
/model
```

This lists all models discovered from the Ollama server, showing their IDs, aliases, status, architecture, and context window.

### Check Ollama Version

```bash
/ollama-version
```

Displays the version of the Ollama server.

### Refresh Model Discovery

```bash
/refresh-model
```

Manually triggers a refresh of the model list from the Ollama server.

## Configuration

### Environment Variables

- `OLLAMA_BASE_URL` - Base URL of the Ollama server (default: `http://localhost:11434`)
- `OLLAMA_API_KEY` - API key for authentication (default: `no-key`)

### Provider Settings

The extension automatically registers models under the `ollama` provider. You can manually register additional models or modify the provider settings via pi:

```bash
pi set ollama.provider-id ollama
pi set ollama.base-url http://your-ollama-server:port
```

## Architecture

- **Provider ID**: `ollama`
- **Base URL**: `http://localhost:11434` (configurable via `OLLAMA_BASE_URL`)
- **API Endpoints**:
  - `/api/tags` - List available models
  - `/api/version` - Get Ollama server version
  - `/api/show` - Get detailed model information
  - `/api/show` (POST) - Query model details by name

## Troubleshooting

- **No models found**: Ensure the Ollama server is running and accessible.
- **Connection refused**: Verify the Ollama server is running on the expected port.
- **Session replacement**: The extension handles stale context errors gracefully.

## License

MIT
