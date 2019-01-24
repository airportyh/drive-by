import * as child_process from "child_process";

async function main() {
    const options = {"cwd":"/Users/airportyh/Home/Playground/hello-world-drive-by"};
    await exec("git add .", options);
    const result = await exec("git status", options);
    console.log(result);
}

function exec(command: string, options: child_process.ExecFileOptions): Promise<string[]> {
    return new Promise((accept, reject) => {
        child_process.exec(command, options, (err, stdout, stderr) => {
            if (err) {
                const message = [
                    err.message,
                    stdout,
                    stderr
                ].filter((part) => !!part)
                .join("\n");
                const customError = new Error(message);
                reject(customError);
            } else {
                accept([stdout, stderr]);
            }
        });
    });
}

main().catch((e) => console.error(e.message));