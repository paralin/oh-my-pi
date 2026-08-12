// @ts-expect-error Bun resolves the extensionless packaged notice as text.
import asset34 from "./NOTICE" with { type: "text" };
import asset4 from "./python/omp/__init__.py" with { type: "text" };
import asset36 from "./python/omp/_managed.py" with { type: "text" };
import asset48 from "./python/omp/ask.py" with { type: "text" };
import asset72 from "./python/omp/ast.py" with { type: "text" };
import asset65 from "./python/omp/autoresearch.py" with { type: "text" };
import asset46 from "./python/omp/browser.py" with { type: "text" };
import asset40 from "./python/omp/code.py" with { type: "text" };
import asset47 from "./python/omp/computer.py" with { type: "text" };
import asset51 from "./python/omp/cron.py" with { type: "text" };
import asset42 from "./python/omp/debug.py" with { type: "text" };
import asset44 from "./python/omp/github.py" with { type: "text" };
import asset5 from "./python/omp/harness.py" with { type: "text" };
import asset49 from "./python/omp/images.py" with { type: "text" };
import asset71 from "./python/omp/long_term_memory.py" with { type: "text" };
import asset68 from "./python/omp/lsp.py" with { type: "text" };
import asset6 from "./python/omp/mcp.py" with { type: "text" };
import asset37 from "./python/omp/memory.py" with { type: "text" };
import asset70 from "./python/omp/process.py" with { type: "text" };
import asset66 from "./python/omp/qa.py" with { type: "text" };
import asset45 from "./python/omp/remote.py" with { type: "text" };
import asset38 from "./python/omp/rules.py" with { type: "text" };
import asset50 from "./python/omp/security.py" with { type: "text" };
import asset7 from "./python/omp/session.py" with { type: "text" };
import asset39 from "./python/omp/skills.py" with { type: "text" };
import asset69 from "./python/omp/tts.py" with { type: "text" };
import asset67 from "./python/omp/vibe.py" with { type: "text" };
import asset43 from "./python/omp/web.py" with { type: "text" };
import asset35 from "./python/pyproject.toml" with { type: "text" };
import asset0 from "./python/rlm/__init__.py" with { type: "text" };
import asset64 from "./python/rlm/_act.py" with { type: "text" };
import asset1 from "./python/rlm/harness.py" with { type: "text" };
import asset2 from "./python/rlm/mcp_base.py" with { type: "text" };
import asset3 from "./python/rlm/skill.py" with { type: "text" };
import asset11 from "./python/skills/agent-message/pyproject.toml" with { type: "text" };
import asset10 from "./python/skills/agent-message/SKILL.md" with { type: "text" };
import asset9 from "./python/skills/agent-message/src/agent_message/__init__.py" with { type: "text" };
import asset14 from "./python/skills/agent-observe/pyproject.toml" with { type: "text" };
import asset13 from "./python/skills/agent-observe/SKILL.md" with { type: "text" };
import asset12 from "./python/skills/agent-observe/src/agent_observe/__init__.py" with { type: "text" };
import asset18 from "./python/skills/attach-image/pyproject.toml" with { type: "text" };
import asset17 from "./python/skills/attach-image/SKILL.md" with { type: "text" };
import asset15 from "./python/skills/attach-image/src/attach_image/__init__.py" with { type: "text" };
import asset16 from "./python/skills/attach-image/src/attach_image/attach_image.py" with { type: "text" };
import asset21 from "./python/skills/compact/pyproject.toml" with { type: "text" };
import asset20 from "./python/skills/compact/SKILL.md" with { type: "text" };
import asset19 from "./python/skills/compact/src/compact/__init__.py" with { type: "text" };
import asset24 from "./python/skills/edit/pyproject.toml" with { type: "text" };
import asset23 from "./python/skills/edit/SKILL.md" with { type: "text" };
import asset22 from "./python/skills/edit/src/edit/__init__.py" with { type: "text" };
import asset27 from "./python/skills/goal/pyproject.toml" with { type: "text" };
import asset26 from "./python/skills/goal/SKILL.md" with { type: "text" };
import asset25 from "./python/skills/goal/src/goal/__init__.py" with { type: "text" };
import asset75 from "./python/skills/helpers/pyproject.toml" with { type: "text" };
import asset74 from "./python/skills/helpers/SKILL.md" with { type: "text" };
import asset73 from "./python/skills/helpers/src/helpers/__init__.py" with { type: "text" };
import asset58 from "./python/skills/linear/pyproject.toml" with { type: "text" };
import asset59 from "./python/skills/linear/SKILL.md" with { type: "text" };
import asset60 from "./python/skills/linear/src/linear/__init__.py" with { type: "text" };
import asset61 from "./python/skills/notion/pyproject.toml" with { type: "text" };
import asset62 from "./python/skills/notion/SKILL.md" with { type: "text" };
import asset63 from "./python/skills/notion/src/notion/__init__.py" with { type: "text" };
import asset30 from "./python/skills/refine/pyproject.toml" with { type: "text" };
import asset29 from "./python/skills/refine/SKILL.md" with { type: "text" };
import asset28 from "./python/skills/refine/src/refine/__init__.py" with { type: "text" };
import asset33 from "./python/skills/rlm-heartbeat/pyproject.toml" with { type: "text" };
import asset32 from "./python/skills/rlm-heartbeat/SKILL.md" with { type: "text" };
import asset31 from "./python/skills/rlm-heartbeat/src/rlm_heartbeat/__init__.py" with { type: "text" };
import asset54 from "./python/skills/websearch/pyproject.toml" with { type: "text" };
import asset55 from "./python/skills/websearch/SKILL.md" with { type: "text" };
import asset56 from "./python/skills/websearch/src/websearch/__init__.py" with { type: "text" };
import asset57 from "./python/skills/websearch/src/websearch/websearch.py" with { type: "text" };

export interface IpythonPythonAsset {
	readonly path: string;
	readonly content: string;
}

export const IPYTHON_PYTHON_ASSETS: readonly IpythonPythonAsset[] = [
	{ path: "rlm/__init__.py", content: asset0 },
	{ path: "rlm/_act.py", content: asset64 },
	{ path: "rlm/harness.py", content: asset1 },
	{ path: "rlm/mcp_base.py", content: asset2 },
	{ path: "rlm/skill.py", content: asset3 },
	{ path: "omp/__init__.py", content: asset4 },
	{ path: "omp/ast.py", content: asset72 },
	{ path: "omp/ask.py", content: asset48 },
	{ path: "omp/autoresearch.py", content: asset65 },
	{ path: "omp/browser.py", content: asset46 },
	{ path: "omp/code.py", content: asset40 },
	{ path: "omp/cron.py", content: asset51 },
	{ path: "omp/computer.py", content: asset47 },
	{ path: "omp/debug.py", content: asset42 },
	{ path: "omp/github.py", content: asset44 },
	{ path: "omp/harness.py", content: asset5 },
	{ path: "omp/lsp.py", content: asset68 },
	{ path: "omp/images.py", content: asset49 },
	{ path: "omp/long_term_memory.py", content: asset71 },
	{ path: "omp/mcp.py", content: asset6 },
	{ path: "omp/qa.py", content: asset66 },
	{ path: "omp/session.py", content: asset7 },
	{ path: "omp/security.py", content: asset50 },
	{ path: "omp/web.py", content: asset43 },
	{ path: "omp/vibe.py", content: asset67 },
	{ path: "omp/_managed.py", content: asset36 },
	{ path: "omp/memory.py", content: asset37 },
	{ path: "omp/process.py", content: asset70 },
	{ path: "omp/remote.py", content: asset45 },
	{ path: "omp/rules.py", content: asset38 },
	{ path: "omp/skills.py", content: asset39 },
	{ path: "omp/tts.py", content: asset69 },
	{ path: "agent_message/__init__.py", content: asset9 },
	{ path: "skills/agent-message/SKILL.md", content: asset10 },
	{ path: "skills/agent-message/pyproject.toml", content: asset11 },
	{ path: "agent_observe/__init__.py", content: asset12 },
	{ path: "skills/agent-observe/SKILL.md", content: asset13 },
	{ path: "skills/agent-observe/pyproject.toml", content: asset14 },
	{ path: "attach_image/__init__.py", content: asset15 },
	{ path: "attach_image/attach_image.py", content: asset16 },
	{ path: "skills/attach-image/SKILL.md", content: asset17 },
	{ path: "skills/attach-image/pyproject.toml", content: asset18 },
	{ path: "compact/__init__.py", content: asset19 },
	{ path: "skills/compact/SKILL.md", content: asset20 },
	{ path: "skills/compact/pyproject.toml", content: asset21 },
	{ path: "edit/__init__.py", content: asset22 },
	{ path: "skills/edit/SKILL.md", content: asset23 },
	{ path: "skills/edit/pyproject.toml", content: asset24 },
	{ path: "goal/__init__.py", content: asset25 },
	{ path: "skills/goal/SKILL.md", content: asset26 },
	{ path: "skills/goal/pyproject.toml", content: asset27 },
	{ path: "helpers/__init__.py", content: asset73 },
	{ path: "skills/helpers/SKILL.md", content: asset74 },
	{ path: "skills/helpers/pyproject.toml", content: asset75 },
	{ path: "refine/__init__.py", content: asset28 },
	{ path: "skills/refine/SKILL.md", content: asset29 },
	{ path: "skills/refine/pyproject.toml", content: asset30 },
	{ path: "rlm_heartbeat/__init__.py", content: asset31 },
	{ path: "skills/rlm-heartbeat/SKILL.md", content: asset32 },
	{ path: "skills/rlm-heartbeat/pyproject.toml", content: asset33 },
	{ path: "skills/websearch/pyproject.toml", content: asset54 },
	{ path: "skills/websearch/SKILL.md", content: asset55 },
	{ path: "websearch/__init__.py", content: asset56 },
	{ path: "websearch/websearch.py", content: asset57 },
	{ path: "skills/linear/pyproject.toml", content: asset58 },
	{ path: "skills/linear/SKILL.md", content: asset59 },
	{ path: "linear/__init__.py", content: asset60 },
	{ path: "skills/notion/pyproject.toml", content: asset61 },
	{ path: "skills/notion/SKILL.md", content: asset62 },
	{ path: "notion/__init__.py", content: asset63 },
	{ path: "NOTICE", content: asset34 },
	{ path: "pyproject.toml", content: asset35 },
];

export function ipythonPythonAssetHash(): string {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const asset of IPYTHON_PYTHON_ASSETS) {
		hasher.update(`${asset.path.length}:${asset.path}\0${asset.content.length}:`);
		hasher.update(asset.content);
	}
	return hasher.digest("hex");
}
