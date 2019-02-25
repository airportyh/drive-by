import { getMasterChangeLog, parseCommitsSummary, getCommit, getCommitShas, getTag, createTag, getTags } from "./git-helpers";
import * as util from "util";
import { fs } from "mz";
import * as child_process from "child_process";
const dir = "/Users/airportyh/Home/Insiten/TAS-Suite";

main().catch(console.log);
async function main() {
    const dir = "/Users/airportyh/Home/Playground/git-play";
    // const tag = await getTag(dir, "foo");
    // console.log("tag", tag);
    console.log(await getTags(dir));
    // await createTag(dir, "foo", "4a3d89f7bdf82a018262e6d4bc72c0df1bd08c3d", "Line 1.\nLine 2");
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

