import type { ExtensionContext } from "../../extensibility/extensions";
import * as git from "../../utils/git";
import { buildExperimentState } from "../state";
import { openAutoresearchStorageIfExists } from "../storage";
import type { AutoresearchOperationOptions, AutoresearchOperationResult } from "../types";

export interface UpdateNotesParams {
	body: string;
	append_idea?: string;
}

interface UpdateNotesDetails {
	notes: string;
}

export async function executeUpdateNotesOwner(
	options: AutoresearchOperationOptions,
	ctx: ExtensionContext,
	params: UpdateNotesParams,
): Promise<AutoresearchOperationResult<UpdateNotesDetails>> {
	const storage = await openAutoresearchStorageIfExists(ctx.cwd);
	const currentBranch = (await git.branch.current(ctx.cwd)) ?? null;
	const session = storage?.getActiveSessionForBranch(currentBranch) ?? null;
	if (!storage || !session) {
		return {
			content: [
				{
					type: "text",
					text: "Error: no active autoresearch session for the current branch. Call omp.autoresearch.init first.",
				},
			],
		};
	}

	const nextNotes =
		params.append_idea !== undefined && params.append_idea.trim().length > 0
			? appendIdea(session.notes, params.append_idea.trim())
			: params.body;

	storage.updateSession(session.id, { notes: nextNotes });
	const refreshed = storage.getSessionById(session.id);
	const loggedRuns = storage.listLoggedRuns(session.id);
	const runtime = options.getRuntime(ctx);
	if (refreshed) {
		runtime.state = buildExperimentState(refreshed, loggedRuns);
	}
	options.dashboard.updateWidget(ctx, runtime);

	return {
		content: [
			{
				type: "text",
				text:
					params.append_idea !== undefined
						? `Appended idea (${nextNotes.length} chars total).`
						: `Notes updated (${nextNotes.length} chars).`,
			},
		],
		details: { notes: nextNotes },
	};
}

const IDEAS_HEADING = "## Ideas";

function appendIdea(currentNotes: string, idea: string): string {
	const trimmed = currentNotes.trimEnd();
	if (trimmed.length === 0) {
		return `${IDEAS_HEADING}\n- ${idea}\n`;
	}
	if (trimmed.includes(IDEAS_HEADING)) {
		const lines = trimmed.split("\n");
		const ideasIndex = lines.findIndex(line => line.trim() === IDEAS_HEADING);
		// find end of ideas section (next heading or end of file)
		let insertAt = lines.length;
		for (let i = ideasIndex + 1; i < lines.length; i += 1) {
			if (/^#{1,6}\s/.test(lines[i] ?? "")) {
				insertAt = i;
				break;
			}
		}
		lines.splice(insertAt, 0, `- ${idea}`);
		return `${lines.join("\n")}\n`;
	}
	return `${trimmed}\n\n${IDEAS_HEADING}\n- ${idea}\n`;
}
