export const EKOKOMVOZ_ARTWORK_SIZE = Object.freeze({ width: 128, height: 100 });
export interface EkokomvozPose { phase: number; direction: -1 | 1; working?: boolean }

/** Side-on municipal sweeper, centered in 128 by 100 pixels. The caller owns scale and time. */
export function paintEkokomvoz(ctx: CanvasRenderingContext2D, pose: EkokomvozPose): void {
    const phase = Number.isFinite(pose.phase) ? ((pose.phase % 1) + 1) % 1 : 0;
    const ink = '#10161d', blue = '#31599b', pale = '#edf3f5';
    const line = (points: readonly (readonly number[])[], color: string, width: number) => {
        ctx.beginPath();
        points.forEach(([x, y], index) => { if (index) { ctx.lineTo(x, y); } else { ctx.moveTo(x, y); } });
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    };
    const polygon = (points: readonly (readonly number[])[], fill: string, stroke = ink) => {
        ctx.beginPath();
        points.forEach(([x, y], index) => { if (index) { ctx.lineTo(x, y); } else { ctx.moveTo(x, y); } });
        ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
        ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke();
    };
    const oval = (x: number, y: number, rx: number, ry: number, fill: string, stroke = '') => {
        ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke(); }
    };
    const box = (x: number, y: number, width: number, height: number, radius: number, fill: string, stroke = ink) => {
        ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fillStyle = fill; ctx.fill();
        ctx.strokeStyle = stroke; ctx.lineWidth = 1.3; ctx.stroke();
    };
    ctx.save();
    try {
        ctx.scale(pose.direction === -1 ? -1 : 1, 1);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        oval(-1, 36, 55, 6, '#06132036');
        // Tall hopper, rear intake housing and broad low chassis give the sweeper its bulk.
        box(-54, -1, 99, 28, 5, '#252d34');
        polygon([[-51, -28], [-30, -37], [9, -34], [15, 6], [-48, 11]], blue, '#152232');
        polygon([[-54, -16], [-43, -29], [-36, -22], [-43, 6], [-54, 9]], '#141c24');
        for (let index = 0; index < 3; index++) {
            line([[-50 + index * 3, -8 - index * 7], [-43 + index * 3, -14 - index * 7]], '#4b5967', 4);
        }
        line([[-36, -37], [-25, -41], [-2, -41], [12, -36]], '#19232c', 4);
        polygon([[-45, 12], [8, 7], [12, 14], [-43, 19]], pale);
        line([[-42, 22], [8, 18]], '#6a7781', 2);
        // Glass cabin and white roof, with the perception mast above its front corner.
        polygon([[13, -33], [41, -31], [47, 6], [42, 23], [12, 21]], '#18232b');
        polygon([[18, -28], [36, -27], [39, 2], [19, 5]], '#8eb7c3', '#e3edf0');
        polygon([[38, -27], [42, -26], [46, 3], [41, 3]], '#5b879b', '#dae8ed');
        line([[22, -25], [22, 2]], '#d5e6ed', 1.5);
        line([[31, -24], [34, -5]], '#d2e9f2a8', 2);
        line([[18, 8], [38, 6], [40, 21]], '#bdcbd4', 1.4);
        box(12, -36, 31, 6, 2, pale);
        line([[29, -37], [29, -42]], '#17232d', 2.4);
        oval(29, -43, 3.3, 2, '#202b32', '#6e91a1');
        box(42, -31, 5, 5, 1, '#c6e8ed');
        box(39, 13, 6, 3, 1, '#f3db8b');
        box(-53, 17, 3, 5, 1, '#df785e');
        // Both large side wheels stay on the same ground plane.
        for (const x of [-30, 27]) {
            oval(x, 27, 13, 13, '#080e14', '#6f7a82');
            oval(x, 27, 9.8, 9.8, '#27343f', '#a9b6bf');
            oval(x, 27, 5.3, 5.3, '#111a22');
            for (let spoke = 0; spoke < 6; spoke++) {
                const angle = spoke * Math.PI / 3 + phase * Math.PI * 2;
                line([[x + Math.cos(angle) * 6.5, 27 + Math.sin(angle) * 6.5],
                    [x + Math.cos(angle) * 8.5, 27 + Math.sin(angle) * 8.5]], pale, 2);
            }
            oval(x, 27, 2.4, 2.4, '#c5d1d8');
        }
        // Forward circular brushes and suction throat, distinct from the wall-climber's blade.
        line([[39, 25], [48, 29], [51, 33]], '#18252f', 3);
        oval(49, 35, 9.5, 2.8, '#152634');
        const brushPhase = pose.working === false ? 0 : phase * Math.PI * 2;
        for (let bristle = 0; bristle < 11; bristle++) {
            const angle = bristle * Math.PI * 2 / 11 + brushPhase;
            const x = 49 + Math.cos(angle) * 8;
            line([[x, 35 + Math.sin(angle) * 1.7], [49 + Math.cos(angle) * 12, 41 + Math.sin(angle) * 2]],
                bristle % 2 ? '#4879b2' : '#a4bdce', 1.4);
        }
        oval(49, 34.5, 5, 1.8, '#293d50', '#93b4c8');
        box(37, 29, 6, 5, 1, '#36454d');
        ctx.fillStyle = '#f4f6f8'; ctx.font = 'bold 6px sans-serif'; ctx.textAlign = 'center';
        ctx.save();
        try {
            ctx.translate(-14, -9);
            if (pose.direction === -1) { ctx.scale(-1, 1); }
            ctx.fillText('EKO', 0, 0);
        } finally { ctx.restore(); }
    } finally { ctx.restore(); }
}
