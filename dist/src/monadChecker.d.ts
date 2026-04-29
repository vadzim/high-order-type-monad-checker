import "core-js";
import type { CGPosition, ContentGraph } from "./buildContentGraph.ts";
export type MonadTypeOption = {
    path: string;
    name: string;
    consumerName: string;
    constructorName: string;
    readerName: string;
    strictMonadModule?: boolean;
};
export type MonadViolation = {
    kind: string;
    message: string;
    position: CGPosition;
    path: string;
    related?: {
        message?: string;
        position: CGPosition;
        path: string;
    }[];
};
export declare function getMonadViolations(graph: ContentGraph, options: MonadTypeOption): MonadViolation[];
