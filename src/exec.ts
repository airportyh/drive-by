import * as child_process from "child_process";

export function exec(command: string, options): Promise<Buffer[]> {
    return new Promise((accept, reject) => {
        child_process.exec(command, options, (err, stdout, stderr) => {
            if (err) {
                const message = [
                    err.message,
                    stdout.toString(),
                    stderr.toString()
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