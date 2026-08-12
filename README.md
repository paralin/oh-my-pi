<p align="center">
  <img src="https://github.com/paralin/oh-my-python/blob/main/assets/hero.png?raw=true" alt="Oh My Python">
</p>

<p align="center">
  <strong>Oh My Python</strong>
</p>

<p align="center">
  <a href="https://github.com/paralin/oh-my-python/blob/main/packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="Changelog"></a>
  <a href="https://github.com/paralin/oh-my-python/actions"><img src="https://img.shields.io/github/actions/workflow/status/paralin/oh-my-python/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/paralin/oh-my-python/blob/main/LICENSE"><img src="https://img.shields.io/github/license/paralin/oh-my-python?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

Oh My Python is a terminal coding agent built around a persistent IPython session. Every model receives only the exclusive `ipython` provider interface; typed Python packages provide code intelligence, browser control, long-running processes, search, subagents, and other host services without adding separate provider tools.

This design keeps imports, variables, working directories, and useful results available across turns. It also gives different models the same provider-visible interface, even when you add skills, extensions, or host integrations.

Oh My Python is a downstream fork of [Oh My Pi](https://github.com/can1357/oh-my-pi) and regularly merges upstream changes.

## Install

Oh My Python currently runs from its source tree. Install [Bun](https://bun.sh), then clone and set up the repository:

```sh
git clone git@github.com:paralin/oh-my-python.git
cd oh-my-python
bun i && bun setup
```

`bun setup` installs the workspace dependencies, builds the native addon, and links the `omp` command into Bun's global bin directory. Make sure that directory, usually `~/.bun/bin`, is on your `PATH`.

## First use

Run the setup assistant to sign in to a provider and choose a default model:

```sh
omp setup
```

Start an interactive session in a project:

```sh
cd /path/to/project
omp
```

You can also send the first request on the command line or run one non-interactive request:

```sh
omp "Explain this repository"
omp -p "List the failing tests"
```

Use `/login` to add provider credentials, `/model` to select models for configured roles, and `Ctrl+P` to cycle through the configured model list.

## Persistent IPython

Each model receives only the exclusive `ipython` function, not separate file, browser, shell, subagent, or extension tools. A call runs one complete Python or `%%bash` cell in the session's retained IPython process. Cells run in order, so later cells can reuse earlier imports, variables, objects, and the current directory.

```python
from pathlib import Path

paths = sorted(Path(".").glob("*.ts"))
print([path.name for path in paths])
```

The TUI shows cell startup, progress, output, errors, cancellation, and artifacts. RPC and ACP clients control the same session without changing the model's interface. The session journal records bounded cell output and host-service results for replay and resume.

A model-originated cell is one exec-level action. `tools.approvalMode` decides whether OMP runs, prompts for, or rejects the whole cell. The runtime does not split a cell into separately approved operations. See the [persistent IPython runtime reference](docs/ipython.md) for lifecycle and authority details.

## Typed capabilities

Python handles normal computation and workspace work. Stateful or authority-sensitive operations remain in the host and are available through typed async Python APIs. The host validates each request, applies session permissions, carries cancellation, and returns structured data.

```python
import omp

symbols = await omp.code.symbols("packages/coding-agent/src/main.ts")
tabs = await omp.browser.tabs()
```

The main capability surfaces are:

- **Typed OMP capabilities.** The kernel exposes `omp.*` services for structural AST work, LSP, process control, speech synthesis, and long-term memory.
- **Retained agent operations.** `rlm` provides task and agent-family operations. Focused packages such as `agent_message`, `agent_observe`, `attach_image`, `compact`, `edit`, `goal`, and `websearch` provide documented workflows.
- **Runtime discovery.** `omp.capabilities()` returns the capability index available in the current session.

## Models and providers

OMP supports direct model APIs, subscription-backed coding plans, gateways, and local OpenAI-compatible servers. Model roles route work by purpose. `default` handles normal turns, while `smol` and `slow` can select inexpensive or deeper-reasoning models. Other supported roles include `vision`, `designer`, `commit`, `tiny`, `task`, and `advisor`.

Authentication labels used below:

- `oauth`: sign in with the provider account through `/login`
- `plan`: use a coding-plan subscription
- `local`: connect to a local server; an API key is optional

### Direct APIs and gateways

Anthropic `oauth` · OpenAI · OpenAI Codex `oauth` · Google Gemini · Google Vertex · Google Antigravity `oauth` · xAI · SuperGrok `oauth` · DeepSeek · Mistral · Groq · Cerebras · Fireworks · Together · Baseten · Hugging Face · NVIDIA · Meta · Amazon Bedrock · Azure OpenAI · SiliconFlow · GMI Cloud · CoreWeave · Sakana AI · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless

### Coding plans

Cursor `oauth` · GitHub Copilot `oauth` · GitLab Duo · Devin `oauth` · Kimi Code `plan` · Moonshot · MiniMax Coding Plan `plan` · MiniMax Coding Plan CN `plan` · Alibaba Coding Plan `plan` · Qwen Portal `oauth` · Z.AI / GLM Coding Plan `plan` · Zhipu Coding Plan `plan` · Xiaomi MiMo · Qianfan · Umans `plan` · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

### Local and self-hosted servers

OMP can discover models from OpenAI-compatible `/v1/models` endpoints.

Ollama `local` · Ollama Cloud · LM Studio `local` · llama.cpp `local` · vLLM `local` · LiteLLM

See the [provider reference](docs/providers.md) for credential precedence, environment variables, local engines, project-specific configuration, and troubleshooting.

### Custom OpenAI-compatible providers

Define a provider in `~/.omp/agent/models.yml`:

```yaml
providers:
  spark:
    baseUrl: http://192.168.10.223:8000/v1
    api: openai-completions
    apiKey: dummy
    models:
      - id: minimax-m3
        name: MiniMax M3
        contextWindow: 100000
        maxTokens: 32000
```

Check discovery with `omp models spark`. Then use `omp setup` or `/model` to assign `spark/minimax-m3` to the `default` role. You can also configure the role directly in `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: spark/minimax-m3
```

Custom providers can use `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-gemini-cli`, or `google-vertex`.

OMP also supports fallback chains, path-scoped model and provider rules, and multiple credentials with session affinity and per-credential backoff. The [provider reference](docs/providers.md) documents these settings.

## Web search

`await omp.web.search(query, provider="auto")` searches through the configured provider chain. Pass a provider ID to select one explicitly. Search handlers can extract structured Markdown from code hosts, package registries, research sources, forums, and documentation sites while retaining links and anchors.

| Provider     | Authentication or endpoint                                 |
| ------------ | ---------------------------------------------------------- |
| `auto`       | Configured chain                                           |
| `perplexity` | Configured auth; explicit selection can use anonymous mode |
| `gemini`     | Gemini CLI or Google Antigravity OAuth                     |
| `anthropic`  | Anthropic OAuth or `ANTHROPIC_API_KEY`                     |
| `codex`      | ChatGPT OAuth through `/login openai-codex`                |
| `xai`        | xAI OAuth or `XAI_API_KEY`                                 |
| `zai`        | `ZAI_API_KEY` or `/login zai`                              |
| `exa`        | `EXA_API_KEY`, `/login exa`, or public MCP fallback        |
| `tinyfish`   | `TINYFISH_API_KEY`                                         |
| `jina`       | `JINA_API_KEY`                                             |
| `kagi`       | `KAGI_API_KEY`                                             |
| `tavily`     | `TAVILY_API_KEY`                                           |
| `firecrawl`  | `FIRECRAWL_API_KEY` or keyless fallback                    |
| `brave`      | `BRAVE_API_KEY`                                            |
| `kimi`       | `/login kimi-code` or a Kimi search key                    |
| `parallel`   | `PARALLEL_API_KEY`                                         |
| `synthetic`  | `SYNTHETIC_API_KEY` or `/login synthetic`                  |
| `searxng`    | `SEARXNG_ENDPOINT` or `searxng.endpoint`                   |
| `startpage`  | No key                                                     |
| `duckduckgo` | No key                                                     |
| `ecosia`     | No key, browser-backed                                     |
| `google`     | No key, browser-backed                                     |
| `mojeek`     | No key, browser-backed                                     |
| `public`     | Consolidated keyless search                                |

Specialized handlers cover GitHub, GitLab, npm, PyPI, crates.io, Hex, Hackage, NuGet, Maven, RubyGems, Packagist, pub.dev, Go packages, arXiv, Semantic Scholar, Stack Overflow, Reddit, Hacker News, MDN, Read the Docs, and docs.rs. Security lookups use NVD, OSV, and CISA KEV data.

## Entry points

The same session engine supports interactive use, one-shot requests, Node or TypeScript embedding, RPC clients, and editors that speak the Agent Client Protocol.

### Terminal

`omp` starts the TUI. `omp -p` processes a prompt and exits. Run `omp --help` for session, model, profile, extension, and output options.

### Node and TypeScript SDK

The `@oh-my-pi/pi-coding-agent` package exports the session, model, and authentication APIs. A minimal embedded session can discover local configuration automatically:

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession();
await session.prompt("List the TypeScript files");
```

For explicit model and session wiring, see the [SDK reference](docs/sdk.md).

### RPC

`omp --mode rpc` starts an NDJSON server on standard input and output. Requests carry IDs, responses echo them, and asynchronous session events stream separately.

```text
< {"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2]}
> {"id":"p1","type":"prompt","message":"Inspect this repository"}
< {"id":"p1","type":"response","command":"prompt","success":true,...}
< {"type":"ipython_cell_start",...}
< {"type":"ipython_cell_end",...}
```

Use `--mode rpc-ui` when the client will answer extension UI requests. See the [RPC protocol reference](docs/rpc.md) for commands, events, durable sessions, limits, and version negotiation.

### ACP

`omp acp` runs an [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) server over JSON-RPC for compatible editors. The editor can provide filesystem and terminal services and participate in permission requests, while the model continues to use the fixed `ipython` interface.

## Extensibility

OMP discovers compatible rules, skills, and MCP configuration from common project directories, including `.claude`, `.cursor`, `.windsurf`, `.gemini`, `.codex`, `.cline`, `.github/copilot`, and `.vscode`.

Python skill packages provide reusable model workflows. Host-side TypeScript extensions can add prompt context, slash commands, rules, skills, session observation, and UI behavior. Extensions do not add provider-callable functions. Reload installed extensions with `/reload-plugins`.

See the [extensions guide](docs/extensions.md), [skills guide](docs/skills.md), [MCP configuration guide](docs/mcp-config.md), and [marketplace guide](docs/marketplace.md).

## Development

A fresh clone needs the Bun workspace dependencies and local Rust/N-API addon before the source CLI starts:

```sh
bun setup
bun dev
```

Run a non-interactive smoke check with:

```sh
bun dev -- --version
```

After changing Rust crates or `packages/natives`, rebuild the addon with `bun run build:native`. See [DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md) for architecture, tests, debugging, and contribution details.

## Contributing

Open issues and pull requests for this fork at [`paralin/oh-my-python`](https://github.com/paralin/oh-my-python). Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. Send changes intended for the original project to [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi).

## License

Oh My Python is available under the [MIT License](LICENSE).

- © 2025 Mario Zechner
- © 2025-2026 Can Bölük
- © 2026 Christian Stewart <christian@cjs.zip>

[Changelog](packages/coding-agent/CHANGELOG.md) · [Fork repository](https://github.com/paralin/oh-my-python) · [Upstream Oh My Pi](https://github.com/can1357/oh-my-pi)
