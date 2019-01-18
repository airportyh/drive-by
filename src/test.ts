import { createChangeTracker } from "./change-tracker";


async function main() {
    const tracker = await createChangeTracker(".");
    const sha = await tracker.pushChange("lib/file3.txt", "Barbara");
    // await tracker.pushChange("file1.txt", "Hello Jason");
    if (!sha) {
        throw new Error("BLARGH");
    }
    const file = await tracker.getChangedFile(sha);
    console.log(file);
    
}

main().catch(console.error);