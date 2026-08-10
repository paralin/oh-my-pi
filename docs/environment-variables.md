# Environment Variables (Current Runtime Reference)

This reference is derived from current code paths in:

- `packages/coding-agent/src/**`
- `packages/ai/src/**` (provider/auth resolution used by coding-agent)
- `packages/utils/src/**` and `packages/tui/src/**` where those vars directly affect coding-agent runtime

It documents only active behavior.

## Resolution model and precedence

Most runtime lookups use `$env` from `@oh-my-pi/pi-utils` (`packages/utils/src/env.ts`).

`$env` loading order:

1. Existing process environment (`Bun.env`)
2. Project `.env` from the launch working directory for keys whose current value is empty/unset
3. Active agent `.env` (normally `~/.omp/agent/.env`) for keys whose current value is empty/unset
4. Active config-root `.env` (normally `~/.omp/.env`) for keys whose current value is empty/unset
5. Home `.env` (`~/.env`) for keys whose current value is empty/unset

The agent/root locations respect profiles, `PI_CONFIG_DIR`, and—only for the default profile—`PI_CODING_AGENT_DIR`. Dotenv names must be shell identifiers (`[A-Za-z_][A-Za-z0-9_]*`); unsafe names/values are discarded. OMP's parser keeps values literal; only Bun's own launch-directory dotenv autoload may perform Bun-supported expansion before this module runs.

Additional rule inside each `.env` file: every `OMP_*` key is mirrored to its `PI_*` alias, and that mirrored value replaces a same-file `PI_*` value. This mirroring applies to parsed dotenv files, not arbitrary variables inherited from the parent process.

---

## 1) Model/provider authentication

These are consumed via `getEnvApiKey()` (`packages/ai/src/stream.ts`) unless noted otherwise.

### Core provider credentials

| Variable                        | Used for                                         | Required when                                                  | Notes / precedence                                                                                  |
| ------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_OAUTH_TOKEN`         | Anthropic API auth                               | Using Anthropic with OAuth token auth                          | Takes precedence over `ANTHROPIC_API_KEY` for provider auth resolution                              |
| `ANTHROPIC_API_KEY`             | Anthropic API auth                               | Using Anthropic without OAuth token                            | Fallback after `ANTHROPIC_OAUTH_TOKEN`                                                              |
| `ANTHROPIC_FOUNDRY_API_KEY`     | Anthropic via Azure Foundry / enterprise gateway | `CLAUDE_CODE_USE_FOUNDRY` enabled                              | Takes precedence over `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` when Foundry mode is enabled  |
| `OPENAI_API_KEY`                | OpenAI auth                                      | Using OpenAI-family providers without explicit apiKey argument | Used by OpenAI Completions/Responses providers                                                      |
| `GEMINI_API_KEY`                | Google Gemini auth                               | Using `google` provider models                                 | Primary key for Gemini provider mapping                                                             |
| `GOOGLE_API_KEY`                | Gemini image tool auth fallback                  | Using `gemini_image` tool without `GEMINI_API_KEY`             | Used by coding-agent image tool fallback path                                                       |
| `GROQ_API_KEY`                  | Groq auth                                        | Using Groq models                                              |                                                                                                     |
| `CEREBRAS_API_KEY`              | Cerebras auth                                    | Using Cerebras models                                          |                                                                                                     |
| `FIREWORKS_API_KEY`             | Fireworks auth                                   | Using Fireworks models                                         |                                                                                                     |
| `FIREPASS_API_KEY`              | Fire Pass auth                                   | Using Fire Pass models                                         |                                                                                                     |
| `TOGETHER_API_KEY`              | Together auth                                    | Using `together` provider                                      |                                                                                                     |
| `AIMLAPI_API_KEY`               | AIML API auth                                    | Using `aimlapi` provider                                       | OpenAI-compatible AIML API endpoint at `https://api.aimlapi.com/v1`                                 |
| `HUGGINGFACE_HUB_TOKEN`         | Hugging Face auth                                | Using `huggingface` provider                                   | Primary Hugging Face token env var                                                                  |
| `HF_TOKEN`                      | Hugging Face auth                                | Using `huggingface` provider                                   | Fallback when `HUGGINGFACE_HUB_TOKEN` is unset                                                      |
| `SYNTHETIC_API_KEY`             | Synthetic auth                                   | Using Synthetic models                                         |                                                                                                     |
| `NVIDIA_API_KEY`                | NVIDIA auth                                      | Using `nvidia` provider                                        |                                                                                                     |
| `NANO_GPT_API_KEY`              | NanoGPT auth                                     | Using `nanogpt` provider                                       |                                                                                                     |
| `NOVITA_API_KEY`                | Novita auth                                      | Using `novita` provider                                        |                                                                                                     |
| `VENICE_API_KEY`                | Venice auth                                      | Using `venice` provider                                        |                                                                                                     |
| `LITELLM_API_KEY`               | LiteLLM auth                                     | Using `litellm` provider                                       | OpenAI-compatible LiteLLM proxy key                                                                 |
| `LM_STUDIO_API_KEY`             | LM Studio auth (optional)                        | Using `lm-studio` provider with authenticated hosts            | Local LM Studio usually runs without auth; any non-empty token works when a key is required         |
| `OLLAMA_API_KEY`                | Ollama auth (optional)                           | Using `ollama` provider with authenticated hosts               | Local Ollama usually runs without auth; any non-empty token works when a key is required            |
| `LLAMA_CPP_API_KEY`             | llama.cpp auth (optional)                        | Using `llama.cpp` provider with authenticated hosts            | Local llama.cpp usually runs without auth; any non-empty token works when a key is configured       |
| `XIAOMI_API_KEY`                | Xiaomi MiMo auth                                 | Using `xiaomi` provider                                        |                                                                                                     |
| `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | Xiaomi MiMo Token Plan auth (AMS)                | Using `xiaomi-token-plan-ams` provider                         |                                                                                                     |
| `XIAOMI_TOKEN_PLAN_CN_API_KEY`  | Xiaomi MiMo Token Plan auth (CN)                 | Using `xiaomi-token-plan-cn` provider                          |                                                                                                     |
| `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | Xiaomi MiMo Token Plan auth (SGP)                | Using `xiaomi-token-plan-sgp` provider                         |                                                                                                     |
| `MOONSHOT_API_KEY`              | Moonshot auth                                    | Using `moonshot` provider                                      |                                                                                                     |
| `XAI_API_KEY`                   | xAI auth                                         | Using xAI models or as fallback for `xai-oauth`                |                                                                                                     |
| `XAI_OAUTH_TOKEN`               | xAI OAuth/SuperGrok auth                         | Using `xai-oauth` provider                                     | Takes precedence over `XAI_API_KEY` for `xai-oauth`                                                 |
| `OPENROUTER_API_KEY`            | OpenRouter auth                                  | Using OpenRouter models                                        | Also used by image tool when preferred/auto provider is OpenRouter                                  |
| `MISTRAL_API_KEY`               | Mistral auth                                     | Using Mistral models                                           |                                                                                                     |
| `ZAI_API_KEY`                   | z.ai auth                                        | Using z.ai models                                              | Also used by z.ai web search provider                                                               |
| `ZHIPU_API_KEY`                 | Zhipu Coding Plan auth                           | Using `zhipu-coding-plan` provider                             |                                                                                                     |
| `UMANS_AI_CODING_PLAN_API_KEY`  | Umans AI Coding Plan auth                        | Using `umans` provider                                         |                                                                                                     |
| `MINIMAX_API_KEY`               | MiniMax auth                                     | Using `minimax` provider                                       |                                                                                                     |
| `MINIMAX_CODE_API_KEY`          | MiniMax Code auth                                | Using `minimax-code` provider                                  |                                                                                                     |
| `MINIMAX_CODE_CN_API_KEY`       | MiniMax Code CN auth                             | Using `minimax-code-cn` provider                               |                                                                                                     |
| `OPENCODE_API_KEY`              | OpenCode auth                                    | Using `opencode-go` / `opencode-zen` models                    |                                                                                                     |
| `QIANFAN_API_KEY`               | Qianfan auth                                     | Using `qianfan` provider                                       |                                                                                                     |
| `QWEN_OAUTH_TOKEN`              | Qwen Portal auth                                 | Using `qwen-portal` with OAuth token                           | Takes precedence over `QWEN_PORTAL_API_KEY`                                                         |
| `QWEN_PORTAL_API_KEY`           | Qwen Portal auth                                 | Using `qwen-portal` with API key                               | Fallback after `QWEN_OAUTH_TOKEN`                                                                   |
| `ZENMUX_API_KEY`                | ZenMux auth                                      | Using `zenmux` provider                                        | Used for ZenMux OpenAI and Anthropic-compatible routes                                              |
| `VLLM_API_KEY`                  | vLLM auth/discovery opt-in                       | Using `vllm` provider (local OpenAI-compatible servers)        | Any non-empty value works for no-auth local servers                                                 |
| `CURSOR_ACCESS_TOKEN`           | Cursor provider auth                             | Using Cursor provider                                          |                                                                                                     |
| `AI_GATEWAY_API_KEY`            | Vercel AI Gateway auth                           | Using `vercel-ai-gateway` provider                             |                                                                                                     |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Cloudflare AI Gateway auth                       | Using `cloudflare-ai-gateway` provider                         | Base URL must be configured as `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` |
| `ALIBABA_CODING_PLAN_API_KEY`   | Alibaba Coding Plan auth                         | Using `alibaba-coding-plan` provider                           |                                                                                                     |
| `ALIBABA_TOKEN_PLAN_API_KEY`    | QwenCloud Token Plan auth                        | Using `alibaba-token-plan` provider                            | Preferred provider-specific name                                                                    |
| `BAILIAN_TOKEN_PLAN_API_KEY`    | QwenCloud Token Plan auth                        | Using `alibaba-token-plan` provider                            | Compatible with Qwen Code's Token Plan preset                                                       |
| `DEEPSEEK_API_KEY`              | DeepSeek auth                                    | Using DeepSeek models                                          |                                                                                                     |
| `SILICONFLOW_API_KEY`           | SiliconFlow auth                                 | Using `siliconflow` provider                                   |                                                                                                     |
| `SILICONFLOW_CN_API_KEY`        | SiliconFlow (China) auth                         | Using `siliconflow-cn` provider                                |                                                                                                     |
| `KILO_API_KEY`                  | Kilo auth                                        | Using Kilo models                                              |                                                                                                     |
| `OLLAMA_CLOUD_API_KEY`          | Ollama Cloud auth                                | Using `ollama-cloud` provider                                  |                                                                                                     |
| `WAFER_SERVERLESS_API_KEY`      | Wafer Serverless auth                            | Using `wafer-serverless` provider                              | Pay-as-you-go Wafer SKU; validated against `https://pass.wafer.ai/v1/models`                        |
| `GITLAB_TOKEN`                  | GitLab Duo auth                                  | Using `gitlab-duo` provider                                    |                                                                                                     |

### GitHub/Copilot tokens

| Variable               | Used for                       | Notes                                     |
| ---------------------- | ------------------------------ | ----------------------------------------- |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot provider auth   | Generic GitHub tokens are not used here   |
| `GH_TOKEN`             | GitHub API auth in web scraper | Web scraper fallback after `GITHUB_TOKEN` |
| `GITHUB_TOKEN`         | GitHub API auth in web scraper | Web scraper checks this before `GH_TOKEN` |

### Auth broker / auth gateway (remote credential vault)

When the broker is enabled, the local SQLite credential store is bypassed and all OAuth refresh / access tokens live on the broker host. See [`auth-broker-gateway.md`](./auth-broker-gateway.md) for the full protocol, CLI surface, and 5-min/15-s usage cache layering.

| Variable                            | Used for                                                                                     | Required when                                                                                                             | Notes / precedence                                                                                                                                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OMP_AUTH_BROKER_URL`               | Base URL of the remote auth-broker (e.g. `https://broker.tailnet:8765`); selects broker mode | Resolving credentials through a broker; also required by `omp auth-gateway serve` (the gateway is itself a broker client) | Wins over `auth.broker.url` in `config.yml`. When set with no resolvable token, `resolveAuthBrokerConfig()` hard-errors instead of falling back to local SQLite.                                                                                                                     |
| `OMP_AUTH_BROKER_TOKEN`             | Bearer token sent on every broker endpoint except `/v1/healthz`                              | `OMP_AUTH_BROKER_URL` is set and no token is available from `auth.broker.token` or `<config-dir>/auth-broker.token`       | Resolution: this env → `auth.broker.token` (`$ENV_NAME` indirection supported) → `<config-dir>/auth-broker.token` (mode `0600`). `<config-dir>` is `~/.omp/` (respecting `PI_CONFIG_DIR`).                                                                                           |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`   | Freshness window for the encrypted local broker snapshot cache                               | Optional in broker mode                                                                                                   | Default `3600000` (1 h). Freshness is based on broker `snapshot.generatedAt`; `0` disables cache reads/writes and forces the old blocking fetch every startup.                                                                                                                       |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE`    | Path to the encrypted local broker snapshot cache                                            | Optional in broker mode                                                                                                   | Defaults to `~/.omp/cache/auth-broker-snapshot.enc` (or XDG cache equivalent). Useful for tests, ephemeral hosts, or relocating the `0600` cache file.                                                                                                                               |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | Process-scoped OAuth account routing for a trusted broker client                             | Optional in broker mode                                                                                                   | Path to a JSON object mapping provider IDs to exact broker `identityKey` arrays. Missing providers are unrestricted; `[]` hides that provider's OAuth accounts; API keys remain visible. Parsed once at startup and fails closed on invalid input. This is not server authorization. |

The gateway has no dedicated env vars — it inherits `OMP_AUTH_BROKER_*`. Its own inbound bearer token lives at `<config-dir>/auth-gateway.token` and is managed via `omp auth-gateway token`.

---

## 2) Provider-specific runtime configuration

### Outbound proxy routing

Provider HTTP fetches resolve proxies in this order after applying `NO_PROXY` / `no_proxy`:

1. `PI_PROXY_<PROVIDER>` (provider ID uppercased, non-alphanumerics replaced with `_`, for example `PI_PROXY_GITHUB_COPILOT`)
2. `PI_PROXY`
3. `HTTPS_PROXY` / `https_proxy` for HTTPS and WebSocket targets, or `HTTP_PROXY` / `http_proxy` for HTTP
4. `ALL_PROXY` / `all_proxy`

Provider proxy lookups are cached for the process lifetime. Localhost targets bypass the provider fetch wrapper.

### Anthropic Foundry Gateway (Azure / enterprise proxy)

When `CLAUDE_CODE_USE_FOUNDRY` is enabled, Anthropic requests switch to Foundry mode:

- Base URL resolves from `FOUNDRY_BASE_URL` (fallback remains model/default base URL if unset).
- API key resolution for provider `anthropic` becomes:
  `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`.
- `ANTHROPIC_CUSTOM_HEADERS` is parsed as comma/newline-separated `key: value`
  pairs and merged into request headers. They are also forwarded when
  `ANTHROPIC_BASE_URL` points to a non-Anthropic host (e.g. a corporate API
  gateway), so enterprise gateways requiring proprietary auth headers work
  without enabling Foundry mode.
- TLS client/server material can be injected from env values:
  `NODE_EXTRA_CA_CERTS`, `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`.
  Each accepts either:
  - a filesystem path to PEM content, or
  - inline PEM (including escaped `\n` sequences).

  `NODE_EXTRA_CA_CERTS` is honoured for every provider fetch (OpenAI-compatible,
  Codex, Ollama, Azure Responses, Google, Anthropic), not just Foundry — Bun's
  `fetch` does not consume the env var natively, so the bundle is merged into
  `RequestInit.tls.ca` alongside the system root store. The `CLAUDE_CODE_*` mTLS
  material remains Anthropic-Foundry-specific.

| Variable                    | Value type                                     | Behavior                                                                                                                                                      |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_USE_FOUNDRY`   | Boolean-like string (`1`, `true`, `yes`, `on`) | Enables Foundry mode for Anthropic provider                                                                                                                   |
| `FOUNDRY_BASE_URL`          | URL string                                     | Anthropic endpoint base URL in Foundry mode                                                                                                                   |
| `ANTHROPIC_FOUNDRY_API_KEY` | Token string                                   | Used for `Authorization: Bearer <token>`                                                                                                                      |
| `ANTHROPIC_CUSTOM_HEADERS`  | Header list string                             | Extra headers; format `header-a: value, header-b: value` or newline-separated. Also forwarded outside Foundry whenever `ANTHROPIC_BASE_URL` is non-Anthropic. |
| `NODE_EXTRA_CA_CERTS`       | PEM path or inline PEM                         | Extra CA chain for server certificate validation                                                                                                              |
| `CLAUDE_CODE_CLIENT_CERT`   | PEM path or inline PEM                         | mTLS client certificate                                                                                                                                       |
| `CLAUDE_CODE_CLIENT_KEY`    | PEM path or inline PEM                         | mTLS client private key (must be paired with cert)                                                                                                            |

### Amazon Bedrock

| Variable                                                                        | Default / behavior                                                                                                                              |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_REGION`                                                                    | Primary region source                                                                                                                           |
| `AWS_DEFAULT_REGION`                                                            | Fallback if `AWS_REGION` unset                                                                                                                  |
| `AWS_PROFILE`                                                                   | Enables named profile auth path                                                                                                                 |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`                                   | Enables IAM key auth path                                                                                                                       |
| `AWS_BEARER_TOKEN_BEDROCK`                                                      | Highest-precedence bearer token auth path; skips AWS profile/credential-chain lookup when set                                                   |
| `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `AWS_CONTAINER_CREDENTIALS_FULL_URI` | Marks Bedrock as available in provider detection (credential resolution itself covers env keys, profiles/SSO/`credential_process`, then IMDSv2) |
| `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN`                                  | Marks Bedrock as available in provider detection (same caveat as the ECS variables above)                                                       |
| `AWS_BEDROCK_SKIP_AUTH`                                                         | If `1`, injects dummy credentials (proxy/non-auth scenarios)                                                                                    |
| `HTTPS_PROXY` / `HTTP_PROXY`                                                    | Honored via Bun's native fetch proxy support (the provider no longer ships an AWS SDK / proxy-agent transport)                                  |
| `NO_PROXY`                                                                      | Excludes matching hosts from Bun's native proxy routing                                                                                         |

Region fallback in provider code: `options.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`.

Additional credential-chain controls implemented by the native Bedrock resolver:

| Variable                                                                      | Behavior                                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `AWS_SESSION_TOKEN`                                                           | Session token paired with `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`                              | Override the shared credentials/config INI paths                        |
| `AWS_SDK_LOAD_CONFIG`                                                         | `1`/`true` enables shared config loading without an explicit profile    |
| `AWS_ROLE_SESSION_NAME`                                                       | Session name for web-identity role assumption                           |
| `AWS_CONTAINER_AUTHORIZATION_TOKEN`, `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` | Authorization for ECS container credentials                             |
| `AWS_EC2_METADATA_DISABLED`                                                   | `true` disables IMDSv2                                                  |
| `AWS_EC2_METADATA_SERVICE_ENDPOINT`, `AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE` | Override IMDS endpoint / select the IPv6 fallback                       |

### Azure OpenAI Responses

| Variable                           | Default / behavior                                                          |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `AZURE_OPENAI_API_KEY`             | Required unless API key passed as option                                    |
| `AZURE_OPENAI_API_VERSION`         | Default `v1`                                                                |
| `AZURE_OPENAI_BASE_URL`            | Direct base URL override                                                    |
| `AZURE_OPENAI_RESOURCE_NAME`       | Used to construct base URL: `https://<resource>.openai.azure.com/openai/v1` |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | Optional mapping string: `modelId=deploymentName,model2=deployment2`        |

Base URL resolution: option `azureBaseUrl` → env `AZURE_OPENAI_BASE_URL` → option/env resource name → `model.baseUrl`.

### Google Vertex AI

| Variable                         | Required?                      | Notes                                                                                                                     |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`           | Yes (unless passed in options) | Primary project ID source                                                                                                 |
| `GCP_PROJECT`                    | Fallback                       | Alternate project ID source                                                                                               |
| `GCLOUD_PROJECT`                 | Fallback                       | Alternate project ID source                                                                                               |
| `GOOGLE_CLOUD_PROJECT_ID`        | OAuth login helper only        | Used by Gemini CLI OAuth project discovery                                                                                |
| `GOOGLE_VERTEX_LOCATION`         | Yes (unless passed in options) | Primary Vertex location source                                                                                            |
| `GOOGLE_CLOUD_LOCATION`          | Fallback                       | Alternate Vertex location source                                                                                          |
| `VERTEX_LOCATION`                | Fallback                       | Alternate Vertex location source                                                                                          |
| `GOOGLE_CLOUD_API_KEY`           | Conditional                    | Direct Vertex API-key auth; otherwise ADC fallback can authenticate when project and location are set                     |
| `GOOGLE_APPLICATION_CREDENTIALS` | Conditional                    | If set, file must exist; otherwise ADC fallback path is checked (`~/.config/gcloud/application_default_credentials.json`) |

`GOOGLE_CLOUD_ACCESS_TOKEN` (or the compatible `CLOUDSDK_AUTH_ACCESS_TOKEN` fallback) supplies an explicit Google OAuth access token and bypasses ADC token acquisition.

### Kimi

| Variable               | Default / behavior                                       |
| ---------------------- | -------------------------------------------------------- |
| `KIMI_CODE_OAUTH_HOST` | Primary OAuth host override                              |
| `KIMI_OAUTH_HOST`      | Fallback OAuth host override                             |
| `KIMI_CODE_BASE_URL`   | Overrides Kimi usage endpoint base URL (`usage/kimi.ts`) |

OAuth host chain: `KIMI_CODE_OAUTH_HOST` → `KIMI_OAUTH_HOST` → `https://auth.kimi.com`.

### OpenAI-compatible endpoint controls

| Variable                            | Default / behavior                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `OPENAI_BASE_URL`                   | Base URL fallback for OpenAI-compatible requests when the model/provider supplies a default |
| `MOONSHOT_BASE_URL`                 | Moonshot chat and model-discovery endpoint override                                         |
| `XAI_BASE_URL`                      | xAI HTTP endpoint override                                                                  |
| `SAKANA_BASE_URL` / `FUGU_BASE_URL` | Sakana/Fugu endpoint override (`SAKANA_BASE_URL` wins)                                      |
| `PI_OPENROUTER_RESPONSES`           | Responses API is enabled unless set to `0`; `0` selects the OpenAI Completions route        |
| `UMANS_WEBSEARCH_PROVIDER`          | Default Umans Anthropic web-search provider selection when not supplied explicitly          |

### Gemini CLI and Antigravity compatibility

| Variable                    | Default / behavior                                              |
| --------------------------- | --------------------------------------------------------------- |
| `PI_AI_GEMINI_CLI_VERSION`  | Overrides Gemini CLI user-agent version tag (`0.46.0` if unset) |
| `PI_AI_ANTIGRAVITY_VERSION` | Overrides the auto-discovered Antigravity hub user-agent version; when unset and discovery fails, the fallback is `2.8.0` |
| `PI_AI_ANTIGRAVITY_CL`      | Overrides Antigravity hub user-agent build changelist (`963137146` if unset) |
| `PI_AI_ANTIGRAVITY_OS`      | Overrides Antigravity hub user-agent os_type (pinned `darwin` if unset) |
| `PI_AI_ANTIGRAVITY_ARCH`    | Overrides Antigravity hub user-agent arch (pinned `arm64` if unset) |

### GitLab Duo

| Variable                         | Default / behavior                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITLAB_CLIENT_ID`               | OAuth client ID. If unset, the bundled GitLab OAuth application client ID is used.                                                                                                                                                                                                                               |
| `GITLAB_REDIRECT_URI`            | Exact OAuth redirect URI advertised to GitLab. If unset, the local callback uses `http://localhost:8080/callback`, with random-port fallback. Must use HTTP or HTTPS; loopback callbacks must use HTTP and bind the URI's host and port.                                                                         |
| `GITLAB_DUO_NAMESPACE_ID`        | Workflow namespace override. Runtime options take precedence; otherwise namespace/project discovery uses the current credentials and working directory.                                                                                                                                                          |
| `GITLAB_DUO_PROJECT_ID`          | Workflow project override by ID. Runtime `projectId`, then runtime `projectPath`, take precedence; this variable takes precedence over `GITLAB_DUO_PROJECT_PATH`.                                                                                                                                                |
| `GITLAB_DUO_PROJECT_PATH`        | Workflow project override by path when no runtime project or `GITLAB_DUO_PROJECT_ID` is set.                                                                                                                                                                                                                     |
| `GITLAB_DUO_WORKFLOW_DEFINITION` | Workflow definition override; runtime `workflowDefinition` takes precedence. Defaults to `ambient`.                                                                                                                                                                                                              |
| `GITLAB_DUO_WORKFLOW_TRACE`      | Workflow tracing is enabled only when the value is exactly `1`. Each trace event is appended as one JSON object per line; trace write failures are ignored.                                                                                                                                                      |
| `GITLAB_DUO_WORKFLOW_TRACE_FILE` | Trace output path. The value is trimmed; unset or blank defaults to the absolute path obtained by resolving `../../../../.tmp/gitlab-duo-workflow-trace.log` from the provider module (in a source checkout, `<repo>/.tmp/gitlab-duo-workflow-trace.log`). Missing parent directories are created automatically. |

`GITLAB_CLIENT_ID` and `GITLAB_REDIRECT_URI` affect OAuth login. The four routing/creation
overrides (`GITLAB_DUO_NAMESPACE_ID`, `GITLAB_DUO_PROJECT_ID`,
`GITLAB_DUO_PROJECT_PATH`, and `GITLAB_DUO_WORKFLOW_DEFINITION`) affect
`gitlab-duo-agent` Workflow namespace/project resolution or workflow creation; they
do not configure OAuth. The two trace variables above affect only local diagnostic
output. A non-loopback
redirect URI cannot be served directly by the local callback listener and
therefore completes through the paste-code path.

### OpenAI Codex responses (feature/debug controls)

| Variable                                    | Behavior                                                                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_CODEX_DEBUG`                            | `1`/`true` enables Codex provider debug logging                                                                                                                                                               |
| `PI_CODEX_WEBSOCKET`                        | `1`/`true` enables websocket transport preference                                                                                                                                                             |
| `PI_CODEX_RESPONSES_LITE`                   | `1`/`true` forces Responses Lite; `0`/`false` forces the standard Responses body; unset uses the model catalog default                                                                                        |
| `PI_OPENAI_STATEFUL`                        | Overrides the stateful-chaining default for the platform OpenAI Responses API (`previous_response_id`, forces `store: true`): on by default against api.openai.com, off elsewhere                             |
| `PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS`        | Positive integer override (default `300000`)                                                                                                                                                                  |
| `PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS` | First-event timeout override (default `300000`)                                                                                                                                                               |
| `PI_CODEX_WEBSOCKET_PING_INTERVAL_MS`       | Ping interval override (default `10000`)                                                                                                                                                                      |
| `PI_CODEX_WEBSOCKET_PONG_TIMEOUT_MS`        | Pong timeout override (default `60000`)                                                                                                                                                                       |
| `PI_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY` | Buffered message capacity override (default `4096`)                                                                                                                                                           |
| `PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS`      | Maximum idle time before a connection is not reused (default `30000`)                                                                                                                                         |
| `PI_CODEX_WEBSOCKET_RETRY_BUDGET`           | Non-negative integer override (default `5`)                                                                                                                                                                   |
| `PI_CODEX_WEBSOCKET_RETRY_DELAY_MS`         | Positive integer base backoff override (default `500`)                                                                                                                                                        |
| `PI_STREAM_FIRST_EVENT_TIMEOUT_MS`          | Generic stream first-event timeout; `0` disables                                                                                                                                                              |
| `PI_STREAM_IDLE_TIMEOUT_MS`                 | Generic stream idle timeout; `0` disables                                                                                                                                                                     |
| `PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS`   | OpenAI-specific first-event timeout override; `0` disables and takes precedence over the generic value. `omp config set providers.streamFirstEventTimeoutSeconds <seconds>` provides the persisted equivalent |
| `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`          | OpenAI-specific idle timeout override; `0` disables and takes precedence over the generic value. `omp config set providers.streamIdleTimeoutSeconds <seconds>` provides the persisted equivalent              |

### Cursor provider debug

| Variable           | Behavior                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| `DEBUG_CURSOR`     | Enables provider debug logs; `2`/`verbose` for detailed payload snippets |
| `DEBUG_CURSOR_LOG` | Optional file path for JSONL debug log output                            |

### Prompt cache compatibility switch

| Variable             | Behavior                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_CACHE_RETENTION` | Cache-retention override where supported (`anthropic`, `openai-responses`, Bedrock). Accepts `long`, `short`, or `none`; other values are ignored |

---

## 3) Web search subsystem

### Search provider credentials

| Variable                                            | Used by                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `EXA_API_KEY`                                       | Exa search/MCP; alternatively use `/login exa`                            |
| `BRAVE_API_KEY`                                     | Brave search provider                                                     |
| `PERPLEXITY_API_KEY`                                | Perplexity search provider API-key mode                                   |
| `PERPLEXITY_COOKIES`                                | Perplexity cookie-auth search mode                                        |
| `PI_PERPLEXITY_RESPONSES`                           | `1` selects the Perplexity Responses endpoint instead of Chat Completions |
| `TAVILY_API_KEY`                                    | Tavily search provider                                                    |
| `ZAI_API_KEY`                                       | z.ai search provider (also checks stored OAuth in `agent.db`)             |
| `OPENAI_API_KEY` / Codex OAuth in DB                | Codex search provider availability/auth                                   |
| `PI_CODEX_WEB_SEARCH_MODEL`                         | Codex search provider model override                                      |
| `GEMINI_SEARCH_MODEL`                               | Gemini search model override                                              |
| `MOONSHOT_SEARCH_API_KEY` / `KIMI_SEARCH_API_KEY`   | Kimi/Moonshot search provider env auth                                    |
| `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` | Kimi/Moonshot search endpoint override                                    |
| `KAGI_API_KEY`                                      | Kagi search provider                                                      |
| `JINA_API_KEY`                                      | Jina search provider                                                      |
| `PARALLEL_API_KEY`                                  | Parallel search provider                                                  |
| `SEARXNG_ENDPOINT`, `SEARXNG_TOKEN`                 | SearXNG endpoint and optional bearer token                                |
| `SEARXNG_BASIC_USERNAME`, `SEARXNG_BASIC_PASSWORD`  | SearXNG HTTP Basic Auth credentials                                       |

SearXNG also reads the equivalent `searxng.endpoint`, `searxng.token`, `searxng.basicUsername`, and `searxng.basicPassword` settings from `~/.omp/agent/config.yml`; environment variables are fallbacks.

### Anthropic web search auth chain

`searchAnthropic()` resolves credentials in this order:

1. `ANTHROPIC_SEARCH_API_KEY`
2. `authStorage.getApiKey("anthropic")` fallback credentials (runtime and config overrides, stored OAuth, a login-sourced API key, generic Anthropic environment fallback, then other stored API keys; the environment fallback is `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` in Foundry mode, or `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` otherwise)

For either credential path, base URL resolution is:

1. `ANTHROPIC_SEARCH_BASE_URL`
2. `FOUNDRY_BASE_URL` when `CLAUDE_CODE_USE_FOUNDRY` is enabled
3. `ANTHROPIC_BASE_URL`
4. `https://api.anthropic.com`

Related vars:

| Variable                    | Default / behavior                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_SEARCH_API_KEY`  | API key used exclusively for the Anthropic web search provider. Highest-priority search auth; overrides `ANTHROPIC_API_KEY` / OAuth / Foundry for search calls without affecting chat completions.                                         |
| `ANTHROPIC_SEARCH_BASE_URL` | Base URL used exclusively for the Anthropic web search provider. Applied to either `ANTHROPIC_SEARCH_API_KEY` or fallback Anthropic credentials; overrides `ANTHROPIC_BASE_URL` (and `FOUNDRY_BASE_URL` in Foundry mode) for search calls. |
| `ANTHROPIC_SEARCH_MODEL`    | Search model override. Defaults to `claude-haiku-4-5`.                                                                                                                                                                                     |
| `ANTHROPIC_BASE_URL`        | Generic fallback base URL for Anthropic requests when no search-specific base URL is set.                                                                                                                                                  |

Use `ANTHROPIC_SEARCH_BASE_URL` (optionally with `ANTHROPIC_SEARCH_API_KEY`) to keep chat routed through an enterprise gateway (`ANTHROPIC_BASE_URL` or `CLAUDE_CODE_USE_FOUNDRY=true`) while pointing web search at a direct Anthropic endpoint, or vice versa.

### Perplexity OAuth flow behavior flag

| Variable            | Behavior                                                                        |
| ------------------- | ------------------------------------------------------------------------------- |
| `PI_AUTH_NO_BORROW` | If set, disables macOS native-app token borrowing path in Perplexity login flow |

---

## 4) Persistent IPython runtime

OMP provisions one retained IPython runtime for each agent session. The runtime
has no environment switch that selects a different provider execution backend.
Use `VIRTUAL_ENV` or `CONDA_PREFIX` only when the provisioner needs to discover
the Python environment. Provider credentials remain in the host and are not
copied into the cell environment.

---

## Security-sensitive variables

Treat these as secrets; do not log or commit them:

- Provider/API keys and OAuth/bearer credentials (all `*_API_KEY`, `*_TOKEN`, OAuth access/refresh tokens)
- Cloud credentials (`AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS` path may expose service-account material)
- Search/provider auth vars (`EXA_API_KEY`, `BRAVE_API_KEY`, `PERPLEXITY_API_KEY`, Anthropic search keys)
- Foundry mTLS material (`CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, `NODE_EXTRA_CA_CERTS` when it points to private CA bundles)

The IPython provisioner keeps provider credentials in the host rather than exposing them to cell processes.
