type CliStreams = {
    log(message: string): void;
    error(message: string): void;
};
export declare function runCli(argv: string[], streams?: CliStreams): Promise<0 | 1>;
export {};
