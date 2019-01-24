import * as child_process from "child_process";

export function exec(command: string, options: child_process.ExecFileOptions): Promise<string[]> {
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