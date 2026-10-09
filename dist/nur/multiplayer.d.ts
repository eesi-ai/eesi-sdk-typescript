/** Someone the character talks with. `id` keys their memories (their name when left out). */
export interface Player {
    name: string;
    id?: string;
    /** What they speak: a code (`"ar"`, `"es-MX"`) or a name. The character answers each in their own. */
    language?: string;
}
export declare function playerKey(player: Player): string;
/** Players from names, `Player` objects, or a `{ name: id }` map. */
export declare function asPlayers(players: Array<Player | string> | Record<string, string> | undefined): Player[];
/** What the character said to whom, and what each player said, newest last. */
export declare class PartyLog {
    private readonly options;
    private lines;
    constructor(options?: {
        maxLines?: number;
        maxChars?: number;
    });
    add(line: string, origin?: string | null): void;
    heard(player: string, text: string, origin?: string | null): void;
    said(character: string, player: string, text: string, origin?: string | null): void;
    /** The `party` block for a session: what happened in the others. */
    render(exclude?: string | null): string;
}
export interface AttributedTurn {
    text: string;
    speaker: number | null;
    /** The player's name, when known. */
    player: string | null;
}
/** `Speaker N` labels bound to the players sharing one conversation, from introductions and order. */
export declare class SpeakerRoster {
    private bySpeaker;
    private expected;
    private waiting;
    private helloOrder;
    constructor(players?: string[]);
    expect(player: string): void;
    assign(speaker: number, player: string): void;
    players(): Map<number, string>;
    attribute(transcript: string): AttributedTurn[];
    /** The `roster` block. `languages` maps a player's name to what they speak. */
    render(languages?: Record<string, string>): string;
    private solo;
    private named;
}
//# sourceMappingURL=multiplayer.d.ts.map