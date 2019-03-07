import { getMasterChangeLog, parseCommitsSummary, getCommitDiff, getCommitShas, getTag, createTag, getTags } from "./git-helpers";
import * as util from "util";
import { fs } from "mz";
import { parsePatch } from "diff";
import { Position } from "vscode";
const dir = "/Users/airportyh/Home/Insiten/TAS-Suite";

main().catch(console.log);
async function main() {
    const dir = "/Users/airportyh/Home/DriveBy/bezier-curve";
    const diff = await getCommitDiff(dir, "d8ccf0a32e0a64875601e90196c6c98a7c2c6ffa");
    console.log(util.inspect(diff, { depth: 10 }));
    const hunks = diff[0].hunks;
    const hunk = hunks[hunks.length - 1];
    const lastLine = hunk.newStart + hunk.newLines;
    
    // console.log("lastLine", lastLine);

//     const diff = `--- /dev/null
// +++ b/dancing.js
// @@ -0,0 +1 @@
// +console.log("Let's dance.");
// \ No newline at end of file`
//     const result = parsePatch(diff);
//     console.log(util.inspect(result, { depth: 10 }));
    // const tag = await getTag(dir, "foo");
    // console.log("tag", tag);
    // console.log(await getTags(dir));
    // await createTag(dir, "foo", "4a3d89f7bdf82a018262e6d4bc72c0df1bd08c3d", "Line 1.\nLine 2");
}

// async function testGetCommit() {
//     const commit = await getCommit(dir, "e0339f07f8b31961324d7f5e82e634e65a8b11fb");
//     console.log(commit);
// }

async function testParseCommitsSummary() {
    const filename = dir + "/gitlog.txt";
    const output = (await fs.readFile(filename)).toString();
    parseCommitsSummary(output);
}

async function testMasterLog() {
    const commits = await getMasterChangeLog(dir);
    console.log(util.inspect(commits, { depth: 10 }));
}

