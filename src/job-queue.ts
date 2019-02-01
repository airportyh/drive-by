import { window } from "vscode";

type Job = () => Promise<void>;

export class JobQueue {
    jobs: Job[] = [];
    running: boolean = false;

    async push(job: Job): Promise<void> {
        this.jobs.push(job);
        await this.ensureRunning();
    }

    async ensureRunning(): Promise<void> {
        if (this.running) {
            return;
        }

        this.running = true;
        while (true) {
            const job = this.jobs.shift();
            window.setStatusBarMessage(`Running ${1} of ${this.jobs.length + 1} jobs.`)
            if (job) {
                try {
                    await job();
                } catch (e) {
                    window.showErrorMessage(e.stack);
                }
            } else {
                this.running = false;
                window.setStatusBarMessage(`Job queue emptied.`);
                break;
            }
        }
    }
}