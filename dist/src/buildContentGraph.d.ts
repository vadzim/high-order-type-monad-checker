export declare function buildContentGraph(filePath: string, content: string): ContentGraph;
export type ContentGraph = {
    refs: Set<CGTypeRef>;
    types: Set<CGType>;
    scopes: Set<CGScope>;
    calls: Set<CGCall>;
};
export type CGPosition = {
    start: number;
    end: number;
};
export type CGScopeKind = "global" | "file" | "declaration" | "typeParameters" | "conditional" | "branchTrue" | "branchFalse" | "infer";
export type CGParsedTypeKind = "typeAlias" | "interface" | "class" | "typeParameter" | "infer";
export type CGTypeArgument = {
    variable: CGTypeRef;
    extends: CGCall | null;
    default: CGCall | null;
};
export type CGType = {
    name: string;
    position: CGPosition;
    arguments: CGTypeArgument[];
    declaration: CGCall | null;
    body: CGCall | null;
    scope: CGScope;
    kind: CGParsedTypeKind;
    called: Set<CGCall>;
    returnedBy: Set<CGTypeRef>;
    returns: Set<CGTypeRef>;
    refs: Set<CGTypeRef>;
    recursion?: Set<CGType>;
};
export type CGTypeRef = {
    ref: CGType;
    name: string;
    position: CGPosition;
    scope: CGScope;
};
export type CGScope = {
    kind: CGScopeKind;
    path: string;
    position: CGPosition;
    types: Set<CGTypeRef>;
    calls: Set<CGCall>;
    parent: CGScope | null;
};
export type CGCall = {
    parent: CGCall | null;
    type: CGTypeRef;
    scope: CGScope;
    arguments: CGCall[];
    position: CGPosition;
};
