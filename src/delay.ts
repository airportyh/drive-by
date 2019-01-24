export function delay(ms: number): Promise<void> {
    return new Promise((accept) => {
        setTimeout(accept, ms);
    });
}