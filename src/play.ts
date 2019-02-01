import { getMasterChangeLog, parseCommitsSummary, getCommit, getCommitShas } from "./git-helpers";
import * as util from "util";
import { fs } from "mz";
import * as child_process from "child_process";
const dir = "/Users/airportyh/Home/Insiten/TAS-Suite";

main();
function main() {
    const child = child_process.spawn("bash", ["-i"], {
        env: {
            PS1: "$ "
        }
    });
    child.stdin.write("node -i\n");
    child.stdout.on("data", (data) => {
        console.log(data.toString());
    });
    child.stderr.on("data", (data) => {
        console.error(data.toString());
    });
    child.on("end", () => {
        process.exit();
    });
}

async function testGetCommit() {
    const commit = await getCommit(dir, "e0339f07f8b31961324d7f5e82e634e65a8b11fb");
    console.log(commit);
}

async function testParseCommitsSummary() {
    const filename = dir + "/gitlog.txt";
    const output = (await fs.readFile(filename)).toString();
    parseCommitsSummary(output);
}

async function testMasterLog() {
    const commits = await getMasterChangeLog(dir);
    console.log(util.inspect(commits, { depth: 10 }));
}

