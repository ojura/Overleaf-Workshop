export type RobotEncounterKind = 'bump' | 'near-miss' | 'reunion' | 'success' | 'rescue';
export interface RobotIncidentDialogue { id: string; kind: RobotEncounterKind; meaningIds: readonly string[]; lines: readonly string[]; source?: string }

/** Stable authored utterance IDs are explicit; text is never used as identity. */
export const ROBOT_AUTHORED_UTTERANCES: Readonly<Record<string, { text: string; source: string }>> = Object.freeze({
    "bump-sorry-lead": { text: "Opa!", source: "Existing authored encounter: bump-sorry" },
    "bump-sorry-reply": { text: "Moja greška.", source: "Existing authored encounter: bump-sorry" },
    "bump-collision-lead": { text: "Kolizije su uključene?!", source: "Existing authored encounter: bump-collision" },
    "bump-collision-reply": { text: "Sad znamo.", source: "Existing authored encounter: bump-collision" },
    "bump-brothers-lead": { text: "Bratski zagrljaj?", source: "Existing authored encounter: bump-brothers" },
    "bump-brothers-reply": { text: "Bez branika, molim.", source: "Existing authored encounter: bump-brothers" },
    "bump-frkalica-lead": { text: "Oprosti, nisam znao da igramo Frkalicu.", source: "Book-inspired dialogue: Frkalica, main.tex:1858–1874" },
    "bump-frkalica-reply": { text: "Bez revanša, molim.", source: "Book-inspired dialogue: Frkalica, main.tex:1858–1874" },
    "bump-scout-lead": { text: "Scout Mini kaže: „Samo sam pet centimetara širi.“", source: "30 godina LARICS-a/main.tex:9336–9350; Scout Mini procurement story, book-inspired satire" },
    "bump-scout-reply": { text: "Ne mjeri me, nisam u javnoj nabavi.", source: "30 godina LARICS-a/main.tex:9336–9350; Scout Mini procurement story, book-inspired satire" },
    "miss-watch-lead": { text: "Pazi kuda ideš!", source: "Existing authored encounter: miss-watch" },
    "miss-watch-reply": { text: "Samo sam razmišljao…", source: "Existing authored encounter: miss-watch" },
    "question-awake": { text: "Budan?", source: "Existing authored encounter: miss-simulation" },
    "miss-simulation-reply": { text: "U simulaciji jesam.", source: "Existing authored encounter: miss-simulation" },
    "warning-route": { text: "Hej! Putanja!", source: "Existing authored encounter: miss-thread" },
    "miss-thread-reply": { text: "Misli su mi odlutale.", source: "Existing authored encounter: miss-thread" },
    "miss-coffee-lead": { text: "Kava. Odmah.", source: "Existing authored encounter: miss-coffee" },
    "miss-coffee-reply": { text: "Prihvaćam korekciju.", source: "Existing authored encounter: miss-coffee" },
    "miss-fuzzy-lead": { text: "Mir, kolega. Danas nema Fightboticsa.", source: "Book-inspired dialogue: Erić main.tex:2781; Kovačić main.tex:2589" },
    "miss-fuzzy-reply": { text: "Budnost mi je malo neizrazita…", source: "Book-inspired dialogue: Erić main.tex:2781; Kovačić main.tex:2589" },
    "miss-kalman-lead": { text: "Origami manevar, bez gužvanja fotke.", source: "Book-inspired dialogue: Car main.tex:2709; Petrinec main.tex:3112" },
    "miss-kalman-reply": { text: "Kalman filtrira. Ja malo drijemam.", source: "Book-inspired dialogue: Car main.tex:2709; Petrinec main.tex:3112" },
    "miss-dream-lead": { text: "Putanja, kolega!", source: "Book-inspired dialogue: electric dreams, main.tex:6317" },
    "miss-dream-reply": { text: "Sanjam električne knjige.", source: "Book-inspired dialogue: electric dreams, main.tex:6317" },
    "miss-rest-reply": { text: "Ne spavam. Obnavljam organizam.", source: "Book-inspired dialogue: skiing rest, main.tex:2116" },
    "miss-caves-reply": { text: "Samo mali đir do Baraćevih špilja.", source: "Book-inspired dialogue: spontaneous cave detour, main.tex:2444" },
    "reunion-wave-lead": { text: "Kolega!", source: "Existing authored encounter: reunion-wave" },
    "reunion-wave-reply": { text: "Daj pet!", source: "Existing authored encounter: reunion-wave" },
    "reunion-beer-lead": { text: "Pivo poslije smjene?", source: "Existing authored encounter: reunion-beer" },
    "reunion-beer-reply": { text: "Kad parkiramo.", source: "Existing authored encounter: reunion-beer" },
    "reunion-team-lead": { text: "Dobra ekipa.", source: "Existing authored encounter: reunion-team" },
    "reunion-team-reply": { text: "Ista putanja kući?", source: "Existing authored encounter: reunion-team" },
    "reunion-marker-lead": { text: "Prijatelja prepoznajem i bez markera.", source: "Book-inspired dialogue: Vasiljević main.tex:3233; Martinović main.tex:2967" },
    "reunion-marker-reply": { text: "Magnetski te vuče dobro društvo.", source: "Book-inspired dialogue: Vasiljević main.tex:3233; Martinović main.tex:2967" },
    "reunion-round-lead": { text: "Petlja zatvorena. Runda otvorena.", source: "Book-inspired dialogue: Oršulić main.tex:3049; Peti main.tex:3092" },
    "reunion-round-reply": { text: "Prvo fotka, onda pivo.", source: "Book-inspired dialogue: Oršulić main.tex:3049; Peti main.tex:3092" },
    "reunion-resource-lead": { text: "Resurs 'zagrljaj' dodijeljen.", source: "Book-inspired dialogue: Petrović main.tex:3122; ROBOBAND main.tex:6412" },
    "reunion-resource-reply": { text: "Uštimani. Kao ROBOBAND.", source: "Book-inspired dialogue: Petrović main.tex:3122; ROBOBAND main.tex:6412" },
    "reunion-lift-lead": { text: "Vidi koga nosi lift!", source: "Book-inspired dialogue: main.tex:1737, 8908" },
    "reunion-lift-reply": { text: "Zrak i zemlja. Najbolji frendovi.", source: "Book-inspired dialogue: main.tex:1737, 8908" },
    "reunion-break-lead": { text: "Još ova fotka, pa treće poluvrijeme.", source: "Book-inspired dialogue: football and Jolly Rogers, main.tex:1737-1756, 6635-6644" },
    "reunion-break-reply": { text: "Još ova fotka, pa na Robijevu svirku.", source: "Book-inspired dialogue: football and Jolly Rogers, main.tex:1737-1756, 6635-6644" },
    "pioneer-viv-team": { text: "Pioneeri bi rekli: „Still got it. Barem nismo završili kao VIV.“", source: "User-supplied Pioneer/VIV callback; the current vehicle keeps its own identity" },
    "success-nailed-lead": { text: "Nailed it.", source: "Existing authored encounter: success-nailed" },
    "success-nailed-reply": { text: "Like a glove.", source: "Existing authored encounter: success-nailed" },
    "success-fit-lead": { text: "Na milimetar.", source: "Existing authored encounter: success-fit" },
    "success-fit-reply": { text: "Timski rad.", source: "Existing authored encounter: success-fit" },
    "success-maric-lead": { text: "ovako fino ne bi ni Marić izbrusio", source: "User-supplied dialogue; ENDORSE grinding by demonstration, main.tex:4583–4589" },
    "success-sofia-lead": { text: "zgrabio sam ga kao SofIA", source: "User-supplied dialogue; SofIA main.tex:6862–6871" },
    "success-mbzirc-lead": { text: "bolje prošlo nego MBZIRC", source: "User-supplied dialogue; mixed MBZIRC 2020 story main.tex:6774, distinct from the 2023 victory at 6813–6815" },
    "success-handoff-lead": { text: "Držiš?", source: "Book-inspired dialogue: Marić main.tex:2927" },
    "success-handoff-reply": { text: "Držim. Sad možeš pustiti.", source: "Book-inspired dialogue: Marić main.tex:2927" },
    "success-map-lead": { text: "Ti mapiraj. Ja čuvam leđa.", source: "Book-inspired dialogue: Milas main.tex:2987; Griparić main.tex:2833" },
    "success-map-reply": { text: "Bzz… imamo konsenzus!", source: "Book-inspired dialogue: Milas main.tex:2987; Griparić main.tex:2833" },
    "success-gentle-lead": { text: "Nježno, kao s malinom.", source: "Book-inspired dialogue: Pevec main.tex:3132; Wachtler main.tex:3288" },
    "success-gentle-reply": { text: "Gripsters petica! Ni piksel ogreben.", source: "Book-inspired dialogue: Pevec main.tex:3132; Wachtler main.tex:3288" },
    "success-memories-lead": { text: "Radionica sreće: dostava uspjela!", source: "Book-inspired dialogue: Kovačević main.tex:2886; Križmančić main.tex:2907" },
    "success-memories-reply": { text: "Fotka po fotka, zid uspomena.", source: "Book-inspired dialogue: Kovačević main.tex:2886; Križmančić main.tex:2907" },
    "success-precision-lead": { text: "U sridu!", source: "Book-inspired dialogue: main.tex:4041–4046, 965–967" },
    "success-precision-reply": { text: "Prvo precizno. Onda Guinness.", source: "Book-inspired dialogue: main.tex:4041–4046, 965–967" },
    "success-care-lead": { text: "Precizno: parizer na 0,7 milimetara.", source: "Book-inspired dialogue: mock menu and compliant manipulation, main.tex:2357, 3272-3278" },
    "success-care-reply": { text: "Nježno, po Jeleninoj školi.", source: "Book-inspired dialogue: mock menu and compliant manipulation, main.tex:2357, 3272-3278" },
    "success-guitar-lead": { text: "Predaja u ritmu. Sad jedan akord!", source: "Book-inspired dialogue: Spudić guitar school, main.tex:3182" },
    "success-matko-lead": { text: "možda mi Matko nešto fino skuha", source: "Exact user-supplied reward line and cooking lore" },
    "success-caca-lead": { text: "možda mi Ćaća nešto fino skuha", source: "User-supplied occasional nickname for Matko and cooking lore" },
    "rescue-smoke-lead": { text: "Pobjegao mi je čarobni dim.", source: "Existing authored encounter: rescue-smoke" },
    "rescue-smoke-reply": { text: "Drži se. Imamo ekipu.", source: "Existing authored encounter: rescue-smoke" },
    "rescue-field-lead": { text: "Terenski rad. Doslovno.", source: "Existing authored encounter: rescue-field" },
    "rescue-field-reply": { text: "Prvo kolega, onda procedura.", source: "Existing authored encounter: rescue-field" },
    "rescue-lugv-lead": { text: "Opet me nosiš? Kakav divan kvar!", source: "Existing authored encounter: rescue-lugv" },
    "rescue-lugv-reply": { text: "Samo ovaj put, kolega.", source: "Existing authored encounter: rescue-lugv" },
    "new-leaves-lead": { text: "Novi listovi? Pa nije prošlo 20 godina!", source: "Recovered whole-book curation, main.tex9484–9487" },
    "new-rjet-lead": { text: "R-JET ekipa, skidamo stari sloj!", source: "Recovered whole-book curation, main.tex1111–1124;4873–4877" },
    "new-clean-lead": { text: "EKO-KOMVOZ, počisti za nama!", source: "Recovered whole-book curation, main.tex4996–5004" },
    "new-orange-lead": { text: "Svi u garažu. Narančastu na gotovs!", source: "Recovered whole-book curation, main.tex9421–9423" },
    "wall-memories-lead": { text: "Zid znamo. Sad slažemo uspomene.", source: "Recovered whole-book curation, main.tex7705;8628" },
    "transport-juraj-lead": { text: "Treba kombi? Zovi Jurja!", source: "Recovered whole-book curation, main.tex9395" },
    "buffer-dough-lead": { text: "Buffer se diže. Kao tijesto.", source: "Recovered whole-book curation, main.tex746–750" },
    "work-found-lead": { text: "Iskopao sam još jednu dobru fotku.", source: "Recovered whole-book curation, main.tex2801" },
    "work-robo-band-lead": { text: "Matko, daj ritam. Mi nosimo!", source: "Recovered whole-book curation, main.tex6412" },
    "work-trio-lead": { text: "Trio biciklistikus, drž’ se!", source: "Recovered whole-book curation, main.tex9283–9294" },
    "work-knots-lead": { text: "Punih šest čvorova. Držite se!", source: "Recovered whole-book curation, main.tex2078–2096" },
    "success-barbara-lead": { text: "Barbara javlja: prvi smo!", source: "Recovered whole-book curation, main.tex6813–6815" },
    "success-solo-pioneer-lead": { text: "Pioneer bi rekao: „Still got it. Barem nisam završio kao VIV.“", source: "Recovered whole-book curation, user-supplied Pioneer/VIV lore; explicitly attributed historical single-robot story" },
    "eagle-pride-lead": { text: "EagleRed. Mit, legenda, dostava.", source: "Recovered whole-book curation, user-supplied EagleRed lore" },
    "scout-var-story-lead": { text: "Scout Mini bi rekao: „Pet centimetara? Zovi VAR.“", source: "Recovered whole-book curation, main.tex9345; explicit attributed story" },
    "scout-mug-story-lead": { text: "Scout Mini bi rekao: „Šalicu imam. Toleranciju tražim.“", source: "Recovered whole-book curation, main.tex9345; explicit attributed story" },
    "pioneer-hold-lead": { text: "Pioneeri bi rekli: „Alpha drži. Bravo preuzima zasluge.“", source: "Pioneer Alpha/Bravo reference, user names;main.tex8084; authored hypothetical credit-taking joke" },
    "pioneer-roll-lead": { text: "Charlie, Delta, Echo, Foxtrot!", source: "Recovered whole-book curation, user-authorized roll call" },
    "aircraft-roll-lead": { text: "Eagle, Hawk, Falcon, Duck, Tukan: pokret!", source: "Recovered whole-book curation, user-authorized drone families" },
    "pioneer-share-lead": { text: "Alpha bi rekao: „Ti jednu stranu, ja drugu.“", source: "Recovered whole-book curation, main.tex8084; two current speakers quote the historical pair" },
    "pioneer-share-reply": { text: "Bravo bi odgovorio: „Fotka na mjestu. Petica, brate!“", source: "Recovered whole-book curation, main.tex8084; two current speakers quote the historical pair" },
    "echo-sonar-lead": { text: "Echo iz Pioneer priče: „Sonar kaže: stari prijatelj!“", source: "Recovered whole-book curation, main.tex7983; explicitly attributed historical character" },
    "foxtrot-path-lead": { text: "Foxtrot iz Pioneer priče: „Putanju znam. Do tebe idem napamet.“", source: "Recovered whole-book curation, main.tex7674; explicitly attributed historical character" },
    "bravo-lasers-lead": { text: "Bravo iz Pioneer priče: „Dva lasera. Petica ravno u metu.“", source: "Recovered whole-book curation, main.tex7980; explicitly attributed historical character" },
    "charlie-qr-lead": { text: "Charlie iz Pioneer priče: „QR potvrđen. Prijatelj prepoznat.“", source: "Recovered whole-book curation, main.tex8087; explicitly attributed historical character" },
    "delta-route-lead": { text: "Delta iz Pioneer priče: „Optimiziram put do tvoje petice.“", source: "Recovered whole-book curation, main.tex7632; explicitly attributed historical character" },
    "eagle-alpha-five-lead": { text: "EagleRed je u priči rekao: „Iz zraka šaljem peticu!“", source: "Recovered whole-book curation, user EagleRed/Alpha assignments; explicitly attributed historical exchange" },
    "eagle-alpha-five-reply": { text: "Alpha je odgovorio: „Spremna! Bravo čuva fotku.“", source: "Recovered whole-book curation, user EagleRed/Alpha assignments; explicitly attributed historical exchange" },
    "buddy-consensus-lead": { text: "Konsenzus?", source: "Recovered whole-book curation, main.tex3092" },
});
const utteranceLines = (ids: readonly string[]): readonly string[] => ids.map(id => {
    const value = ROBOT_AUTHORED_UTTERANCES[id];
    if (!value) { throw new Error("Unknown authored utterance: " + id); }
    return value.text;
});
function incident(id: string, kind: RobotEncounterKind, meaningIds: readonly string[], source?: string): RobotIncidentDialogue {
    return { id, kind, meaningIds, lines: utteranceLines(meaningIds), source };
}

export const ROBOT_ENCOUNTER_DIALOGUE: readonly RobotIncidentDialogue[] = Object.freeze([
    incident("bump-sorry", "bump", ["bump-sorry-lead","bump-sorry-reply"]),
    incident("bump-collision", "bump", ["bump-collision-lead","bump-collision-reply"]),
    incident("bump-brothers", "bump", ["bump-brothers-lead","bump-brothers-reply"]),
    incident("bump-frkalica", "bump", ["bump-frkalica-lead","bump-frkalica-reply"], "Book-inspired dialogue: Frkalica, main.tex:1858–1874"),
    incident("bump-scout", "bump", ["bump-scout-lead","bump-scout-reply"], "30 godina LARICS-a/main.tex:9336–9350; Scout Mini procurement story, book-inspired satire"),
    incident("miss-watch", "near-miss", ["miss-watch-lead","miss-watch-reply"]),
    incident("miss-simulation", "near-miss", ["question-awake","miss-simulation-reply"]),
    incident("miss-thread", "near-miss", ["warning-route","miss-thread-reply"]),
    incident("miss-coffee", "near-miss", ["miss-coffee-lead","miss-coffee-reply"]),
    incident("miss-fuzzy", "near-miss", ["miss-fuzzy-lead","miss-fuzzy-reply"], "Book-inspired dialogue: Erić main.tex:2781; Kovačić main.tex:2589"),
    incident("miss-kalman", "near-miss", ["miss-kalman-lead","miss-kalman-reply"], "Book-inspired dialogue: Car main.tex:2709; Petrinec main.tex:3112"),
    incident("miss-dream", "near-miss", ["miss-dream-lead","miss-dream-reply"], "Book-inspired dialogue: electric dreams, main.tex:6317"),
    incident("miss-rest", "near-miss", ["question-awake","miss-rest-reply"], "Book-inspired dialogue: skiing rest, main.tex:2116"),
    incident("miss-caves", "near-miss", ["warning-route","miss-caves-reply"], "Book-inspired dialogue: spontaneous cave detour, main.tex:2444"),
    incident("reunion-wave", "reunion", ["reunion-wave-lead","reunion-wave-reply"]),
    incident("reunion-beer", "reunion", ["reunion-beer-lead","reunion-beer-reply"]),
    incident("reunion-team", "reunion", ["reunion-team-lead","reunion-team-reply"]),
    incident("reunion-marker", "reunion", ["reunion-marker-lead","reunion-marker-reply"], "Book-inspired dialogue: Vasiljević main.tex:3233; Martinović main.tex:2967"),
    incident("reunion-round", "reunion", ["reunion-round-lead","reunion-round-reply"], "Book-inspired dialogue: Oršulić main.tex:3049; Peti main.tex:3092"),
    incident("reunion-resource", "reunion", ["reunion-resource-lead","reunion-resource-reply"], "Book-inspired dialogue: Petrović main.tex:3122; ROBOBAND main.tex:6412"),
    incident("reunion-lift", "reunion", ["reunion-lift-lead","reunion-lift-reply"], "Book-inspired dialogue: main.tex:1737, 8908"),
    incident("reunion-break", "reunion", ["reunion-break-lead","reunion-break-reply"], "Book-inspired dialogue: football and Jolly Rogers, main.tex:1737-1756, 6635-6644"),
    incident("reunion-pioneers", "reunion", ["pioneer-viv-team"], "User-supplied Pioneer/VIV callback; the current vehicle keeps its own identity"),
    incident("success-nailed", "success", ["success-nailed-lead","success-nailed-reply"]),
    incident("success-fit", "success", ["success-fit-lead","success-fit-reply"]),
    incident("success-maric", "success", ["success-maric-lead"], "User-supplied dialogue; ENDORSE grinding by demonstration, main.tex:4583–4589"),
    incident("success-sofia", "success", ["success-sofia-lead"], "User-supplied dialogue; SofIA main.tex:6862–6871"),
    incident("success-mbzirc", "success", ["success-mbzirc-lead"], "User-supplied dialogue; mixed MBZIRC 2020 story main.tex:6774, distinct from the 2023 victory at 6813–6815"),
    incident("success-handoff", "success", ["success-handoff-lead","success-handoff-reply"], "Book-inspired dialogue: Marić main.tex:2927"),
    incident("success-map", "success", ["success-map-lead","success-map-reply"], "Book-inspired dialogue: Milas main.tex:2987; Griparić main.tex:2833"),
    incident("success-gentle", "success", ["success-gentle-lead","success-gentle-reply"], "Book-inspired dialogue: Pevec main.tex:3132; Wachtler main.tex:3288"),
    incident("success-memories", "success", ["success-memories-lead","success-memories-reply"], "Book-inspired dialogue: Kovačević main.tex:2886; Križmančić main.tex:2907"),
    incident("success-precision", "success", ["success-precision-lead","success-precision-reply"], "Book-inspired dialogue: main.tex:4041–4046, 965–967"),
    incident("success-care", "success", ["success-care-lead","success-care-reply"], "Book-inspired dialogue: mock menu and compliant manipulation, main.tex:2357, 3272-3278"),
    incident("success-guitar", "success", ["success-guitar-lead"], "Book-inspired dialogue: Spudić guitar school, main.tex:3182"),
    incident("success-matko", "success", ["success-matko-lead"], "Exact user-supplied reward line and cooking lore"),
    incident("success-caca", "success", ["success-caca-lead"], "User-supplied occasional nickname for Matko and cooking lore"),
    incident("rescue-smoke", "rescue", ["rescue-smoke-lead","rescue-smoke-reply"]),
    incident("rescue-field", "rescue", ["rescue-field-lead","rescue-field-reply"]),
    incident("rescue-lugv", "rescue", ["rescue-lugv-lead","rescue-lugv-reply"]),
]);

/** Semantic speech opportunities are independent of optional motion/incident admission. */
export type RobotDialogueOpportunity = 'new-book' | 'preparing' | 'carrying' | 'deposit' | 'returning' | 'waiting' | 'greeting'
    | 'success' | 'bump' | 'near-miss' | 'reunion' | 'rescue';
export interface RobotDialogueSpeaker { id: number; vehicle: string; name: string }
export interface RobotDialogueRole { vehicles?: readonly string[]; names?: readonly string[] }
export interface RobotDialogueEntry {
    id: string;
    opportunities: readonly RobotDialogueOpportunity[];
    lines: readonly string[];
    roles?: readonly RobotDialogueRole[];
    minParticipants?: number;
    maxParticipants?: number;
    fallback?: boolean;
    meaningIds?: readonly string[];
    source: string;
}
export interface RobotDialogueChoice {
    readonly opportunity: RobotDialogueOpportunity;
    readonly token: number;
    readonly key: string;
    readonly entry: RobotDialogueEntry;
    readonly speakers: readonly number[];
    readonly lines: readonly string[];
}
function hash(value: string, seed: number): number {
    let result = seed >>> 0;
    for (const character of value) { result = Math.imul(result ^ character.charCodeAt(0), 16777619); }
    return result >>> 0;
}
function assign(entry: RobotDialogueEntry, actors: readonly RobotDialogueSpeaker[]): number[] | undefined {
    if (actors.length < (entry.minParticipants ?? entry.lines.length) || actors.length > (entry.maxParticipants ?? 12)) { return; }
    if (!entry.lines.length || entry.lines.length > 3 || entry.roles && entry.roles.length !== entry.lines.length) { return; }
    const selected: number[] = [];
    const match = (index: number): boolean => {
        if (index === entry.lines.length) { return true; }
        const role = entry.roles?.[index];
        for (const actor of actors) {
            if (selected.includes(actor.id) || role?.vehicles && !role.vehicles.includes(actor.vehicle)
                || role?.names && !role.names.includes(actor.name)) { continue; }
            selected.push(actor.id);
            if (match(index + 1)) { return true; }
            selected.pop();
        }
        return false;
    };
    return match(0) ? selected : undefined;
}
/** A reservation is immutable. Only first readable display commits catalogue coverage. */
export class RobotDialogueSelection {
    private readonly reservations = new Map<string, { choice: RobotDialogueChoice; shown: boolean; geometry: string }>();
    private readonly coverage = new Map<string, { count: number; last: number }>();
    private readonly blocked = new Map<string, string>();
    private serial = 0;
    private shown = 0;
    private dropped = 0;
    private lastRejected?: { id: string; meaningIds: readonly string[]; reason: 'intrinsic-fit' };
    private eligible = 0;
    private readonly opportunities = new Map<RobotDialogueOpportunity, number>();
    constructor(private readonly catalogue: readonly RobotDialogueEntry[], private readonly seed = 0, private readonly maxReservations = 32) {
        this.catalogue = Object.freeze(catalogue.map(entry => Object.freeze({ ...entry,
            meaningIds: Object.freeze(entry.meaningIds ? [...entry.meaningIds] : entry.lines.map((_line, index) => entry.lines.length === 1 ? entry.id : entry.id + ':' + index)),
            opportunities: Object.freeze([...entry.opportunities]), lines: Object.freeze([...entry.lines]),
            roles: entry.roles && Object.freeze(entry.roles.map(role => Object.freeze({ ...role,
                vehicles: role.vehicles && Object.freeze([...role.vehicles]), names: role.names && Object.freeze([...role.names]) }))) })));
        const ids = new Set<string>();
        const meanings = new Map<string, string>();
        for (const entry of this.catalogue) {
            if (!entry.id || ids.has(entry.id) || !entry.source || !entry.lines.length || entry.lines.some(line => !line.trim())) {
                throw new Error('Dialogue entries require unique IDs, authored text and source provenance.');
            }
            if (entry.meaningIds!.length !== entry.lines.length || new Set(entry.meaningIds).size !== entry.lines.length) {
                throw new Error('Each dialogue line requires a distinct authored meaning ID.');
            }
            entry.meaningIds!.forEach((id, index) => {
                if (!id || meanings.has(id) && meanings.get(id) !== entry.lines[index]) {
                    throw new Error('A shared authored meaning ID must reference the same text.');
                }
                meanings.set(id, entry.lines[index]);
            });
            ids.add(entry.id);
        }
    }
    reserve(key: string, opportunity: RobotDialogueOpportunity, actors: readonly RobotDialogueSpeaker[], geometry = 'default', allowedIds?: readonly string[]): RobotDialogueChoice | undefined {
        const existing = this.reservations.get(key);
        if (existing) { return existing.choice; }
        if (!key || this.reservations.size >= this.maxReservations || actors.length > 12
            || actors.some(actor => !Number.isSafeInteger(actor.id) || actor.id < 1)
            || new Set(actors.map(actor => actor.id)).size !== actors.length) { return; }
        const candidates = this.catalogue.flatMap(entry => {
            const speakers = entry.opportunities.includes(opportunity) && (!allowedIds || allowedIds.includes(entry.id)) && this.blocked.get(entry.id) !== geometry ? assign(entry, actors) : undefined;
            return speakers ? [{ entry, speakers }] : [];
        });
        this.eligible += candidates.length;
        const reserved = (entry: RobotDialogueEntry) => [...this.reservations.values()].filter(value => !value.shown
            && value.choice.entry.meaningIds!.some(id => entry.meaningIds!.includes(id))).length;
        const exposure = (entry: RobotDialogueEntry) => entry.meaningIds!.reduce((sum, id) => sum + (this.coverage.get(id)?.count ?? 0), 0) / entry.meaningIds!.length;
        const recency = (entry: RobotDialogueEntry) => Math.max(...entry.meaningIds!.map(id => this.coverage.get(id)?.last ?? -1));
        candidates.sort((a, b) => Number(!!a.entry.fallback) - Number(!!b.entry.fallback)
            || exposure(a.entry) - exposure(b.entry)
            || reserved(a.entry) - reserved(b.entry)
            || recency(a.entry) - recency(b.entry)
            || hash(key + ':' + a.entry.id, this.seed) - hash(key + ':' + b.entry.id, this.seed));
        const selected = candidates[0];
        if (!selected) { return; }
        const choice = Object.freeze({ opportunity, token: ++this.serial, key, entry: selected.entry,
            speakers: Object.freeze(selected.speakers), lines: Object.freeze([...selected.entry.lines]) });
        this.reservations.set(key, { choice, shown: false, geometry });
        return choice;
    }
    admit(choice: RobotDialogueChoice): boolean {
        const reservation = this.reservations.get(choice.key);
        if (!reservation || reservation.choice !== choice || reservation.shown) { return false; }
        reservation.shown = true;
        const admitted = ++this.shown;
        this.opportunities.set(choice.opportunity, (this.opportunities.get(choice.opportunity) ?? 0) + 1);
        for (const id of choice.entry.meaningIds!) {
            const prior = this.coverage.get(id);
            this.coverage.set(id, { count: (prior?.count ?? 0) + 1, last: admitted });
        }
        return true;
    }
    /** A measured non-fitting cue is not an exposure. Retry it only when that layout domain changes. */
    rejectGeometry(choice: RobotDialogueChoice): void {
        const reservation = this.reservations.get(choice.key);
        if (!reservation || reservation.choice !== choice || reservation.shown) { return; }
        this.lastRejected = { id: choice.entry.id, meaningIds: choice.entry.meaningIds!, reason: 'intrinsic-fit' };
        this.blocked.set(choice.entry.id, reservation.geometry);
        this.release(choice);
    }
    release(choice: RobotDialogueChoice): void {
        const reservation = this.reservations.get(choice.key);
        if (!reservation || reservation.choice !== choice) { return; }
        if (!reservation.shown) { this.dropped++; }
        this.reservations.delete(choice.key);
    }
    clear(): void { for (const value of this.reservations.values()) { this.release(value.choice); } }
    reset(): void { this.clear(); this.coverage.clear(); this.blocked.clear(); this.opportunities.clear(); this.lastRejected = undefined; this.serial = this.shown = this.dropped = this.eligible = 0; }
    snapshot() {
        return { lastRejected: this.lastRejected, reserved: this.reservations.size, blocked: this.blocked.size, eligible: this.eligible, selected: this.serial, shown: this.shown, dropped: this.dropped,
            opportunities: Object.fromEntries(this.opportunities), coverage: [...this.coverage].map(([id, value]) => ({ id, ...value })) };
    }
}

/** Every recovered motif has an explicit truthful opportunity; historical names are attributed lore. */
function work(id: string, opportunities: readonly RobotDialogueOpportunity[], meaningIds: readonly string[], source: string, constraints: Partial<Pick<RobotDialogueEntry, "roles" | "minParticipants" | "maxParticipants">> = {}): RobotDialogueEntry {
    return { id, opportunities, meaningIds, lines: utteranceLines(meaningIds), source, ...constraints };
}
export const ROBOT_CURATED_WORK_DIALOGUE: readonly RobotDialogueEntry[] = [
    work("new-leaves", ["new-book"], ["new-leaves-lead"], "Recovered whole-book curation, main.tex9484–9487"),
    work("new-rjet", ["new-book"], ["new-rjet-lead"], "Recovered whole-book curation, main.tex1111–1124;4873–4877"),
    work("new-clean", ["new-book"], ["new-clean-lead"], "Recovered whole-book curation, main.tex4996–5004"),
    work("new-orange", ["new-book"], ["new-orange-lead"], "Recovered whole-book curation, main.tex9421–9423"),
    work("wall-memories", ["new-book","carrying"], ["wall-memories-lead"], "Recovered whole-book curation, main.tex7705;8628"),
    work("transport-juraj", ["new-book","carrying","preparing"], ["transport-juraj-lead"], "Recovered whole-book curation, main.tex9395"),
    work("buffer-dough", ["preparing"], ["buffer-dough-lead"], "Recovered whole-book curation, main.tex746–750"),
    work("work-organism", ["waiting"], ["miss-rest-reply"], "Recovered whole-book curation, main.tex2116"),
    work("work-electric", ["waiting"], ["miss-dream-reply"], "Recovered whole-book curation, main.tex6317"),
    work("work-rest", ["waiting"], ["miss-fuzzy-reply"], "Recovered whole-book curation, main.tex2589"),
    work("work-kalman", ["waiting"], ["miss-kalman-reply"], "Recovered whole-book curation, main.tex3112"),
    work("work-care", ["carrying","preparing"], ["success-care-reply"], "Recovered whole-book curation, main.tex3272–3278"),
    work("work-precision", ["carrying"], ["success-care-lead"], "Recovered whole-book curation, main.tex2357"),
    work("work-origami", ["carrying","preparing"], ["miss-kalman-lead"], "Recovered whole-book curation, main.tex2709–2710"),
    work("work-album", ["carrying","preparing"], ["success-memories-reply"], "Recovered whole-book curation, main.tex2907"),
    work("work-found", ["carrying"], ["work-found-lead"], "Recovered whole-book curation, main.tex2801"),
    work("work-football", ["carrying"], ["reunion-break-lead"], "Recovered whole-book curation, main.tex1737–1756"),
    work("work-music", ["carrying"], ["reunion-break-reply"], "Recovered whole-book curation, main.tex6635–6644"),
    work("work-robo-band", ["carrying"], ["work-robo-band-lead"], "Recovered whole-book curation, main.tex6412", {"minParticipants":2}),
    work("work-trio", ["carrying"], ["work-trio-lead"], "Recovered whole-book curation, main.tex9283–9294", {"minParticipants":3}),
    work("work-knots", ["carrying"], ["work-knots-lead"], "Recovered whole-book curation, main.tex2078–2096", {"minParticipants":2}),
    work("success-barbara", ["deposit"], ["success-barbara-lead"], "Recovered whole-book curation, main.tex6813–6815"),
    work("success-solo-pioneer", ["deposit"], ["success-solo-pioneer-lead"], "Recovered whole-book curation, user-supplied Pioneer/VIV lore; explicitly attributed historical single-robot story", {"maxParticipants":1}),
    work("eagle-pride", ["carrying","deposit"], ["eagle-pride-lead"], "Recovered whole-book curation, user-supplied EagleRed lore", {"roles":[{"names":["EagleRed"]}]}),
    work("scout-var-story", ["greeting","carrying"], ["scout-var-story-lead"], "Recovered whole-book curation, main.tex9345; explicit attributed story"),
    work("scout-mug-story", ["greeting","carrying"], ["scout-mug-story-lead"], "Recovered whole-book curation, main.tex9345; explicit attributed story"),
    work("pioneer-hold", ["carrying"], ["pioneer-hold-lead"], "Pioneer Alpha/Bravo reference, user names;main.tex8084; authored hypothetical credit-taking joke"),
    work("pioneer-roll", ["greeting"], ["pioneer-roll-lead"], "Recovered whole-book curation, user-authorized roll call"),
    work("aircraft-roll", ["greeting"], ["aircraft-roll-lead"], "Recovered whole-book curation, user-authorized drone families"),
    work("pioneer-share", ["carrying"], ["pioneer-share-lead","pioneer-share-reply"], "Recovered whole-book curation, main.tex8084; two current speakers quote the historical pair"),
    work("echo-sonar", ["reunion"], ["echo-sonar-lead"], "Recovered whole-book curation, main.tex7983; explicitly attributed historical character"),
    work("foxtrot-path", ["reunion"], ["foxtrot-path-lead"], "Recovered whole-book curation, main.tex7674; explicitly attributed historical character"),
    work("bravo-lasers", ["reunion"], ["bravo-lasers-lead"], "Recovered whole-book curation, main.tex7980; explicitly attributed historical character"),
    work("charlie-qr", ["reunion"], ["charlie-qr-lead"], "Recovered whole-book curation, main.tex8087; explicitly attributed historical character"),
    work("delta-route", ["reunion"], ["delta-route-lead"], "Recovered whole-book curation, main.tex7632; explicitly attributed historical character"),
    work("eagle-alpha-five", ["reunion"], ["eagle-alpha-five-lead","eagle-alpha-five-reply"], "Recovered whole-book curation, user EagleRed/Alpha assignments; explicitly attributed historical exchange"),
    work("buddy-consensus", ["reunion"], ["buddy-consensus-lead"], "Recovered whole-book curation, main.tex3092"),
    work("success-team-pioneer", ["deposit"], ["pioneer-viv-team"], "User-supplied Pioneer/VIV lore; explicitly attributed historical team story", {"minParticipants":2}),
];

/** Incidents and ordinary opportunities reference the same authored meanings and exposure ledger. */
export function robotDialogueCatalogue(incidents: readonly { id: string; kind: string; meaningIds?: readonly string[]; lines: readonly string[]; source?: string }[], interaction?: { greetings: readonly string[]; carrying: string; preparing: string; returning: string; waiting: string }): readonly RobotDialogueEntry[] {
    const entries: RobotDialogueEntry[] = [...incidents.map(entry => ({ id: entry.id,
        opportunities: [entry.kind as RobotDialogueOpportunity, ...(entry.kind === "success" ? ["deposit" as const] : []),
            ...(["success-matko", "success-caca"].includes(entry.id) ? ["returning" as const] : [])],
        meaningIds: entry.meaningIds, lines: entry.lines, source: entry.source ?? "Existing authored encounter: " + entry.id })), ...ROBOT_CURATED_WORK_DIALOGUE];
    if (interaction) {
        for (const opportunity of ["carrying", "preparing", "returning", "waiting"] as const) {
            entries.push({ id: "fallback-" + opportunity, meaningIds: ["status-" + opportunity], opportunities: [opportunity], lines: [interaction[opportunity]],
                fallback: true, source: "Operational status fallback; only used without a fitting authored option" });
        }
        interaction.greetings.forEach((line, index) => entries.push({ id: "fallback-greeting-" + index, meaningIds: ["greeting-" + index],
            opportunities: ["greeting"], lines: [line], fallback: true, source: "Existing operational greeting fallback" }));
    }
    return entries;
}
