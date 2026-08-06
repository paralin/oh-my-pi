import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const protoDir = resolve(packageRoot, "proto");
const generatedDir = resolve(packageRoot, "src/parent/generated");
const proto = resolve(protoDir, "parent-environment.proto");
const binDir = resolve(packageRoot, "../../node_modules/.bin");

const command = [
	"protoc",
	`--plugin=protoc-gen-es-lite=${resolve(binDir, "protoc-gen-es-lite")}`,
	`--plugin=protoc-gen-es-starpc=${resolve(binDir, "protoc-gen-es-starpc")}`,
	`--es-lite_out=${generatedDir}`,
	"--es-lite_opt=target=ts,ts_nocheck=false",
	`--es-starpc_out=${generatedDir}`,
	"--es-starpc_opt=target=ts",
	"-I",
	protoDir,
	proto,
];
const result = Bun.spawnSync(command, { cwd: packageRoot, stdout: "inherit", stderr: "inherit" });
if (!result.success) process.exit(result.exitCode);

const files = ["parent-environment.pb.ts", "parent-environment_srpc.pb.ts"];
const sha256 = async (path: string) =>
	new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
const manifest = {
	schema: "proto/parent-environment.proto",
	schemaSha256: await sha256(proto),
	generated: Object.fromEntries(
		await Promise.all(files.map(async file => [file, await sha256(resolve(generatedDir, file))])),
	),
	plugins: { protobuf: "protoc-gen-es-lite target=ts,ts_nocheck=false", starpc: "protoc-gen-es-starpc target=ts" },
};
await Bun.write(resolve(generatedDir, "BINDINGS.json"), `${JSON.stringify(manifest, null, 2)}\n`);
