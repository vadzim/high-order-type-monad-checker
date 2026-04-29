export declare function never(message?: string): never;
type InspectOptions = {
    colors?: boolean;
};
export declare function inspect(value: unknown, options?: InspectOptions): string;
export declare function serialize(value: unknown): string;
export {};
