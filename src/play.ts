import * as child_process from "child_process";
import { getMasterChangeLog } from "./git-helpers";
import * as util from "util";

async function main() {
    const dir = "/Users/airportyh/Home/Playground/hello-world-drive-by";
    const commits = await getMasterChangeLog(dir);
    console.log(util.inspect(commits, { depth: 10 }));
}

main().catch((e) => console.error(e.stack));