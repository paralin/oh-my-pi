export * from "./client.js";
export * from "./config.js";
export { ParentCapability, TaskAgentSource } from "./generated/parent-environment.pb.js";

import { ParentCapability } from "./generated/parent-environment.pb.js";
export const PARENT_CHILD_CAPABILITIES = [
	ParentCapability.TASK_SUBMIT,
	ParentCapability.TASK_WATCH,
	ParentCapability.SESSION_INTERRUPT,
	ParentCapability.PEER_MESSAGE_SEND,
	ParentCapability.PEER_MESSAGE_RECEIVE,
] as const;
