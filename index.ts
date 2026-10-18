/**
 * ollama provider for pi.
 *
 * Auto-discovers models from a running `ollama` server and registers them under the `ollama` provider.
 *
 * Usage: `pi install github.com/agpenton/pi-ollama`
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { Loader, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PROVIDER_ID = "ollama";
const DEFAULT_BASE_URL = "http://localhost:11434";
// Fallback context window
const DEFAULT_CONTEXT_WINDOW = 8192;
// ollama has no output-token cap (no endpoint reports one; generation is only bounded by the context window)
// so use Pi's own default for models that omit maxTokens (see model-registry.ts parseModels).
const DEFAULT_MAX_TOKENS = 16384;
const PROPS_TIMEOUT_MS = 120_000;

// Ollama /api/tags response schema
const TagsResponseSchema = Type.Object({
	models: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String(),
				model: Type.Optional(Type.String()),
				modified_at: Type.Optional(Type.String()),
				size: Type.Optional(Type.Number()),
				digest: Type.Optional(Type.String()),
				details: Type.Optional(
					Type.Object({
						parent_modal: Type.Optional(Type.String()),
						format: Type.Optional(Type.String()),
						family: Type.Optional(Type.String()),
						families: Type.Optional(
							Type.Union([Type.Array(Type.String()), Type.Null()]),
						),
						parameter_size: Type.Optional(Type.String()),
						quantization_level: Type.Optional(Type.String()),
					}, { additionalProperties: true }),
				),
				capabilities: Type.Optional(Type.Array(Type.String())),
			}, { additionalProperties: true }),
		),
	),
}, { additionalProperties: true });

const validateTagsResponse = Compile(TagsResponseSchema);

// SSE event types for model loading progress (ollama doesn't have SSE progress like llama.cpp, but we'll keep the structure)
type ApiModelLoadStage = "text_model" | "spec_model" | "mmproj_model";

type ApiModelsSseProgress = {
	stages: ApiModelLoadStage[];
	current: ApiModelLoadStage;
	value: number;
};

type ApiModelsSseData = {
	status: string;
	progress?: ApiModelsSseProgress;
	exit_code?: number;
};

type ApiModelsSseEvent = {
	model: string;
	event: string;
	data: ApiModelsSseData;
};

const MODEL_LOAD_STAGE_LABELS: Record<ApiModelLoadStage, string> = {
	text_model: "Loading weights",
	spec_model: "Loading draft",
	mmproj_model: "Loading projector",
};

type OllamaModel = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["models"]>[number];
type ExtensionCtx = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];

// Minimal shape needed to update both registered models and Pi's active model snapshot.
type MutableModelMetadata = {
	reasoning: boolean;
	thinkingLevelMap?: OllamaModel["thinkingLevelMap"];
	compat?: OllamaModel["compat"];
	contextWindow: number;
	maxTokens: number;
};

// Ollama doesn't have template thinking support in the same way as llama.cpp
function applyTemplateThinkingSupport(model: MutableModelMetadata): void {
	model.reasoning = true;
	model.thinkingLevelMap = {
		minimal: null,
		low: null,
		high: null,
		xhigh: null,
	} satisfies NonNullable<OllamaModel["thinkingLevelMap"]>;
	model.compat = {
		...model.compat,
		thinkingFormat: "ollama-chat-template",
	};
}

// Pi invalidates a captured ctx when the session is replaced (e.g. new_session in RPC mode).
// Any later ctx access then throws this error. Background work started before the replacement
// should treat it as "session gone" and stop quietly.
function isStaleContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("stale after session replacement");
}

function notify(
	ctx: ExtensionCtx | undefined,
	message: string,
	type?: "info" | "warning" | "error",
): void {
	try {
		ctx?.ui.notify(message, type);
	} catch (error) {
		if (!isStaleContextError(error)) {
			console.warn(message);
		}
	}
}

export default async function (pi: ExtensionAPI) {
	let currentModels: OllamaModel[] = [];

	pi.registerCommand("ollama-version", {
		description: "Get version of ollama server",
		handler: async (_args, ctx) => {
			const response = await fetch(`${DEFAULT_BASE_URL}/api/version`);
			if (!response.ok) {
				ctx.ui.notify(`[ollama] /api/version returned ${response.status}`, "error");
				return;
			}

			const data: unknown = await response.json();
			if (typeof data === "object" && data !== null && "version" in data) {
				ctx.ui.notify(`Ollama version: ${(data as { version: string }).version}`, "info");
			} else {
				ctx.ui.notify(`Unexpected version response: ${JSON.stringify(data)}`, "warning");
			}
		},
	});

	const baseUrl = (process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const apiKey = process.env.OLLAMA_API_KEY ?? "no-key";

	async function refreshProvider(): Promise<void> {
		try {
			const response = await fetch(`${baseUrl}/api/tags`);
			if (!response.ok) {
				console.warn(`[ollama] ${baseUrl}/api/tags returned ${response.status}`);
				return;
			}

			const payload: unknown = await response.json();
			if (!validateTagsResponse.Check(payload)) {
				const errors = [...validateTagsResponse.Errors(payload)]
					.map((e) => `${"path" in e ? e.path : ""} ${e.message}`)
					.join("; ");
				console.warn(`[ollama] invalid /api/tags response: ${errors}`);
				return;
			}

			const previousById = new Map(currentModels.map((m) => [m.id, m]));

			currentModels = (payload.models ?? []).map((model) => {
				const previous = previousById.get(model.name);
				// Ollama doesn't report loading status via /api/tags, so we'll assume models are available
				const isLoaded = true; // Simplified - in reality we'd need to check if model is loaded
				const contextWindow =
					// Try to extract from model details or use default
					previous?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
				const displayName = model.name;
				return {
					id: model.name,
					name: displayName,
					// Ollama models don't have built-in reasoning detection via API
					// We'll preserve reasoning state across refreshes
					reasoning: previous?.reasoning ?? false,
					thinkingLevelMap: previous?.thinkingLevelMap,
					input: ["text"], // Ollama primarily text-only for now
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow,
					maxTokens: Math.min(DEFAULT_MAX_TOKENS, contextWindow),
					compat: previous?.compat,
					status: isLoaded ? { value: "loaded" } : undefined,
				} as OllamaModel;
			});

			if (currentModels.length === 0) {
				console.warn(`[ollama] no models returned from ${baseUrl}/api/tags`);
				return;
			}

			pi.registerProvider(PROVIDER_ID, {
				name: "ollama",
				baseUrl: `${baseUrl}/v1`,
				apiKey,
				api: "openai-completions",
				models: currentModels,
			});
		} catch (error) {
			console.warn(`[ollama] failed to reach ${baseUrl}/api/tags: ${(error as Error).message}`);
		}
	}

	const discoveredMetadata = new Set<string>();
	const pendingMetadata = new Set<string>();
	let currentlyLoadedModel: string | null = null;
	let statusTimeout: ReturnType<typeof setTimeout> | undefined;
	let sseAbortController: AbortController | null = null;
	let propsAbortController: AbortController | null = null;

	function clearFooterStatusTimeout(): void {
		if (statusTimeout !== undefined) {
			clearTimeout(statusTimeout);
			statusTimeout = undefined;
		}
	}

	// Ollama doesn't have SSE for model loading progress, but we'll keep the function stub
	async function connectToLoadingProgress(
		modelId: string,
		ctx: ExtensionCtx,
		loader: Loader,
	): Promise<void> {
		// Ollama doesn't provide SSE progress for model loading
		// Just show a simple loading message
		if (ctx) {
			ctx.ui.setWidget(PROVIDER_ID, [
				ctx.ui.theme.fg("accent", " [ollama]") +
					ctx.ui.theme.fg("text", ` ${modelId}: Loading...`),
			]);
		}
	}

	async function discoverModelMetadata(
		modelId: string,
		ctx?: ExtensionCtx,
		autoload = true,
		timeoutMs = PROPS_TIMEOUT_MS,
		selectedModel?: MutableModelMetadata,
	): Promise<void> {
		const model = currentModels.find((m) => m.id === modelId);
		if (!model) {
			return;
		}
		const displayName = model.name.split(" ")[0];
		// For ollama, we consider models loaded when selected
		const isLoaded = currentlyLoadedModel === modelId;

		if (discoveredMetadata.has(modelId)) {
			if (!isLoaded) {
				discoveredMetadata.delete(modelId);
			} else {
				if (selectedModel) {
					selectedModel.contextWindow = model.contextWindow;
					selectedModel.maxTokens = model.maxTokens;
					if (model.reasoning) {
						selectedModel.reasoning = model.reasoning;
						selectedModel.thinkingLevelMap = model.thinkingLevelMap;
						selectedModel.compat = model.compat;
					}
				}
				return;
			}
		}
		if (pendingMetadata.has(modelId)) {
			return;
		}

		pendingMetadata.add(modelId);
		clearFooterStatusTimeout();
		if (propsAbortController) {
			propsAbortController.abort();
		}
		propsAbortController = new AbortController();
		const timer = setTimeout(() => propsAbortController.abort(), timeoutMs);
		const shouldAutoload = autoload && !isLoaded;
		// Ollama doesn't have a /props endpoint, we'll simulate metadata discovery
		const propsUrl = `${baseUrl}/api/show`; // Ollama has /api/show for model info
		const clearFooterStatusLater = () => {
			clearFooterStatusTimeout();
			statusTimeout = setTimeout(() => {
				statusTimeout = undefined;
				ctx?.ui.setWidget(PROVIDER_ID, undefined);
			}, 8000);
		};

		try {
			if (shouldAutoload && ctx) {
				let loader = null;
				ctx.ui.setWidget(PROVIDER_ID, (ui, theme) => {
					const prefix = theme.fg("accent", " [ollama]");
					const prefixWidth = visibleWidth(" [ollama]");
					loader = new Loader(
						ui,
						(s) => theme.fg("accent", s),
						(t) => theme.fg("text", t),
						`${displayName}: Loading...`,
					);
					return {
						dispose: () => loader?.stop(),
						render: (width: number) => {
							const [_, line] = loader.render(width - prefixWidth);
							return [prefix + truncateToWidth(line, width - prefixWidth)];
						},
					};
				});
				// Start progress simulation
				void connectToLoadingProgress(modelId, ctx, loader);
			}

			// Fetch model details from ollama
			const response = await fetch(propsUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: modelId }),
				signal: propsAbortController.signal,
			});

			if (!response.ok) {
				if (!(shouldAutoload && response.status === 404)) {
					ctx?.ui.notify(`[ollama] /api/show for ${modelId} returned ${response.status}`, "error");
				}
				return;
			}
			const data: unknown = await response.json();
			
			let updated = false;
			let loadedFooterStatus = shouldAutoload ? `[ollama] ${displayName} loaded` : undefined;
			
			// Try to extract context window from model details
			if (typeof data === "object" && data !== null) {
				// Ollama doesn't directly expose context window in /api/show
				// We'll look for common patterns or use defaults
				// Some models might have this information in details or parameters
				const paramSize = data.details?.parameter_size;
				if (paramSize) {
					// Rough estimate based on parameter size - this is heuristic
					const sizeMatch = paramSize.match(/(\d+)([bB])/);
					if (sizeMatch) {
						const sizeNum = parseInt(sizeMatch[1]);
						// Very rough estimation: larger models might have larger context windows
						// This is just a placeholder - real implementation would need model-specific data
						const estimatedCtx = Math.min(32768, Math.max(2048, sizeNum * 128));
						if (estimatedCtx !== model.contextWindow) {
							model.contextWindow = estimatedCtx;
							model.maxTokens = Math.min(DEFAULT_MAX_TOKENS, estimatedCtx);
							loadedFooterStatus = `[ollama] ${displayName} loaded with estimated ctx ${estimatedCtx} tokens`;
							updated = true;
						}
					}
				}
			}

			if (selectedModel) {
				selectedModel.contextWindow = model.contextWindow;
				selectedModel.maxTokens = model.maxTokens;
			}
			
			// Ollama doesn't have template thinking detection via API
			// We'll leave reasoning detection to user configuration or model naming conventions
			
			discoveredMetadata.add(modelId);
			if (shouldAutoload) {
				currentlyLoadedModel = modelId;
			}
			if (loadedFooterStatus && ctx && !isLoaded) {
				const prefix = ctx.ui.theme.fg("success", "[ollama] ✓");
				ctx.ui.setWidget(PROVIDER_ID, [
					prefix +
						ctx.ui.theme.fg(
							"text",
							` ${displayName}: Loaded`,
						),
				]);
				clearFooterStatusLater();
			}
			if (!updated) {
				return;
			}
			pi.registerProvider(PROVIDER_ID, {
				name: "ollama",
				baseUrl: `${baseUrl}/v1`,
				apiKey,
				api: "openai-completions",
				models: currentModels,
			});
		} catch (error) {
			const err = error as Error;
			if (err.name !== "AbortError" && !isStaleContextError(err)) {
				notify(ctx, `[ollama] /api/show for ${modelId} failed: ${err.message}`, "error");
			}
		} finally {
			clearTimeout(timer);
			pendingMetadata.delete(modelId);
			propsAbortController = null;
			if (sseAbortController) {
				sseAbortController.abort();
				sseAbortController = null;
			}
		}
	}

	await refreshProvider();

	pi.on("input", async (event) => {
		const trimmed = event.text.trim().toLowerCase();
		if (trimmed === "/model") {
			await refreshProvider();
		}
	});

	pi.on("model_select", (event, ctx) => {
		if (event.model.provider !== PROVIDER_ID) {
			return;
		}
		void discoverModelMetadata(event.model.id, ctx, true, PROPS_TIMEOUT_MS, event.model);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			if (ctx.model?.provider === PROVIDER_ID) {
				await discoverModelMetadata(ctx.model.id, ctx, true, PROPS_TIMEOUT_MS, ctx.model);
			}
		} catch (error) {
			if (!isStaleContextError(error)) {
				throw error;
			}
		}
	});

	pi.on("session_shutdown", () => {
		clearFooterStatusTimeout();
		propsAbortController?.abort();
		sseAbortController?.abort();
	});
}