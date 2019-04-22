import { getChangeRanges } from "./git-helpers";
import * as assert from "assert";

async function main() {
    await getChangeRangesTests();
}

main().catch(console.log);

async function getChangeRangesTests() {
    const dir = "/Users/airportyh/Home/OpenSource/my-ui-kit";
    let changeRange;
    // let changeRange = await getChangeRanges(dir, "2ad478581c04747cf02e2e7c158aad8fb67fb889");
    // if (!changeRange) throw new Error("Failed");
    // assert.deepEqual(changeRange, {
    //     after: {
    //         start: { line: 8, character: 1 },
    //         end: { line: 10, character: 2 }
    //     },
    //     before: {
    //         start: { line: 7, character: 1 },
    //         end: { line: 7, character: 1 } }
    //     }
    // );

    // changeRange = await getChangeRanges(dir, "2ca0e98d7351c87929366724dd0a1ef66f22f7b7");
    // if (!changeRange) throw new Error("Failed");
    // assert.deepEqual(changeRange, {
    //     after: {
    //         start: { line: 1, character: 1 },
    //         end: { line: 1, character: 19 }
    //     },
    //     before: {
    //         start: { line: 1, character: 1 },
    //         end: { line: 1, character: 65 }
    //     }
    // });

    // changeRange = await getChangeRanges(dir, "39998194dda32139ad29d2df6ebd206aff8f649f");
    // if (!changeRange) throw new Error("Failed");
    // assert.deepEqual(changeRange, { after:
    //     { start: { line: 37, character: 1 },
    //       end: { line: 38, character: 14 } },
    //    before:
    //     { start: { line: 37, character: 1 },
    //       end: { line: 37, character: 10 } }});

    // changeRange = await getChangeRanges(dir, "3e7b242a343a5c17cf0b292b2a17a13d791fdf83");
    // if (!changeRange) throw new Error("Failed");
    // assert.deepEqual(changeRange, { after:
    //     { start: { line: 29, character: 1 },
    //       end: { line: 29, character: 48 } },
    //    before:
    //     { start: { line: 29, character: 1 },
    //       end: { line: 29, character: 38 } } });

    // changeRange = await getChangeRanges(dir, "1d8630f4ad267bbd33d20c76dcfc92deb4ed4732");
    // if (!changeRange) throw new Error("Failed");
    // assert.deepEqual(changeRange, { after:
    //     { start: { line: 21, character: 13 },
    //       end: { line: 21, character: 13 } },
    //    before:
    //     { start: { line: 22, character: 1 },
    //       end: { line: 23, character: 21 } } });

    changeRange = await getChangeRanges(dir, "a358491b86a6086625d9537d50ba15e24673c174");
    if (!changeRange) throw new Error("Failed");
    
    
}

// async function testParseCommitsSummary() {
//     const filename = dir + "/gitlog.txt";
//     const output = (await fs.readFile(filename)).toString();
//     parseCommitsSummary(output);
// }

// async function testMasterLog() {
//     const commits = await getMasterChangeLog(dir);
//     console.log(util.inspect(commits, { depth: 10 }));
// }

