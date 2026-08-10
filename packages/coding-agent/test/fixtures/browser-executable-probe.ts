import { ensureChromiumExecutable } from "../../src/tools/browser/launch.js";

const platform = process.env.OMP_BROWSER_PROBE_PLATFORM;
if (platform) Object.defineProperty(process, "platform", { value: platform });

const executable = await ensureChromiumExecutable();
process.stdout.write(executable ?? "");
