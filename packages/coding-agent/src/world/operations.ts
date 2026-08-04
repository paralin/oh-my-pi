/** The five authority-checked World operations, in tool-facing spelling. */
export const WORLD_OPERATIONS = [
	"dispatch_submit",
	"dispatch_watch",
	"question_answer",
	"session_input",
	"session_interrupt",
] as const;

export type WorldOperation = (typeof WORLD_OPERATIONS)[number];

/** The permission ID GLaDOS checks for each operation. */
export const WORLD_OPERATION_PERMISSIONS: Readonly<Record<WorldOperation, string>> = {
	dispatch_submit: "world.dispatch.submit",
	dispatch_watch: "world.dispatch.watch",
	question_answer: "world.question.answer",
	session_input: "world.session.input",
	session_interrupt: "world.session.interrupt",
};

/** Every permission ID a child dispatch may receive, in operation order. */
export const WORLD_CHILD_PERMISSIONS: readonly string[] = WORLD_OPERATIONS.map(
	operation => WORLD_OPERATION_PERMISSIONS[operation],
);
