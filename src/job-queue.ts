type Job = () => Promise<void>;

export class JobQueue {
    jobs: Job[] = [];
    running: boolean = false;

    push(job: Job): void {
        this.jobs.push(job);
        this.ensureRunning();
    }

    async ensureRunning(): Promise<void> {
        if (this.running) {
            return;
        }
        this.running = true;
        while (true) {
            const job = this.jobs.shift();
            if (job) {
                await job();
            } else {
                this.running = false;
                break;
            }
        }
    }
}