export const ASAP_CLEANER_ARTWORK_SIZE = Object.freeze({ width: 128, height: 100 });

export interface AsapCleanerPose {
    /** One wiping cycle in [0, 1); finite values outside that interval wrap. */
    phase: number;
    /** +1 leads right; -1 mirrors the complete mechanical pose horizontally. */
    direction: -1 | 1;
}

/**
 * ASAP wall climber with its four steering modules, open EDF duct, paired outrigger props and
 * squeegee. The origin is the chassis center, with positive y downward. Every pose fits the
 * centered 128 by 100 artwork rectangle. The caller owns translation, scale and animation.
 * This helper preserves context state and paints into the existing canvas without clearing it.
 */
export function paintAsapCleaner(ctx: CanvasRenderingContext2D, pose: AsapCleanerPose): void {
    const cycle = Number.isFinite(pose.phase) ? ((pose.phase % 1) + 1) % 1 : 0;
    const angle = cycle * Math.PI * 2, ink = '#0a1728', steel = '#647b95', light = '#e6f4ff';
    const line = (points: number[][], color: string, width: number) => {
        ctx.beginPath();
        points.forEach(([x, y], index) => { if (index) { ctx.lineTo(x, y); } else { ctx.moveTo(x, y); } });
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    };
    const ellipse = (x: number, y: number, rx: number, ry: number, fill: string, stroke = '', rotation = 0) => {
        ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
        ctx.fillStyle = fill; ctx.fill();
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.1; ctx.stroke(); }
    };
    const box = (x: number, y: number, width: number, height: number, radius: number, fill: string, stroke = ink) => {
        ctx.beginPath(); ctx.roundRect(x, y, width, height, radius);
        ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 1.3; ctx.stroke();
    };
    const steeringModule = (x: number, y: number) => {
        ellipse(x, y + 10, 6.5, 9, '#09121d', steel);
        ellipse(x, y + 10, 3.7, 6, '#b4c5cf');
        ellipse(x, y + 10, 1.3, 2, '#354e60');
        box(x - 7, y - 8, 14, 13, 2, '#20557d', '#5481a0');
        box(x - 5.8, y - 17, 11.6, 19, 2, '#111b27', '#374b5e');
        line([[x - 3.7, y - 14], [x - 3.7, y - 1]], '#263b4d', 1.3);
        ellipse(x, y - 15, 4.5, 2.4, '#263646', '#8da6b6');
        ellipse(x, y - 15, 1.6, 1, light);
    };
    ctx.save();
    try {
        ctx.scale(pose.direction === -1 ? -1 : 1, 1);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ellipse(0, 21, 34, 10, '#06132038');
        for (const side of [-1, 1]) {
            line([[side * 20, 1], [side * 47, 1]], ink, 6);
            line([[side * 20, 0], [side * 47, 0]], '#466d86', 2.5);
            line([[side * 48, -11], [side * 48, 11]], '#172b3d', 4);
            for (const y of [-11, 11]) {
                const spin = angle * 3 + side * 0.6 + y * 0.04;
                ellipse(side * 49, y, 12, 1.8, '#243a4e', '#7697ad', spin);
                ellipse(side * 49, y, 3.2, 3.2, '#1b2936', '#a9becb');
                ellipse(side * 49, y, 1.2, 1.2, light);
            }
        }
        box(-29, -13, 58, 38, 5, '#173b59', '#7599b0');
        box(-27, -14, 54, 27, 4, '#245f8a', '#71a7c8');
        line([[-24, -7], [-11, 12], [12, 12], [24, -7]], '#3c83ad', 2);
        line([[-24, 13], [24, 13]], '#0d2c44', 2);
        for (const x of [-24, 24]) { steeringModule(x, -14); }
        box(-11, -24, 22, 11, 2, '#17222e', '#52687b');
        line([[-8, -21], [3, -21]], '#4a6478', 1);
        ellipse(7, -20, 1.3, 1.3, '#8fe3d3');
        ellipse(0, 4, 13, 8, '#101e2c', '#839eaf');
        box(-13, -8, 26, 12, 2, '#142736', '#58788e');
        ellipse(0, -8, 13, 8.5, '#293e4d', '#c1d4df');
        ellipse(0, -8, 9.6, 5.8, '#030a12');
        line([[-5, -7], [0, -4], [5, -7]], '#304e62', 0.8);
        ellipse(0, -5, 2.2, 1.2, '#607989');
        for (const x of [-18, 18]) { for (const y of [-7, 10]) { ellipse(x, y, 1.2, 1.2, '#b2cedd'); } }
        box(-14, 14, 28, 10, 2, '#101e2a', '#4e7390');
        for (const x of [-8, -3, 3, 8]) { ellipse(x, 18, 1.5, 1.1, x < 0 ? '#9ddce6' : '#c7e2d6'); }
        for (const x of [-24, 24]) { steeringModule(x, 17); }
        const tipX = 49 + Math.sin(angle) * 2, tipY = 27 + Math.cos(angle) * 3;
        const arm = [[17, 16], [33, 29], [tipX, tipY]];
        line(arm, ink, 6); line(arm, '#9cb8c9', 3);
        for (const [x, y] of [arm[0], arm[1]]) { ellipse(x, y, 2.6, 2.6, '#b9ceda', '#355269'); }
        const lean = Math.sin(angle) * 0.12, dx = Math.sin(lean) * 13, dy = Math.cos(lean) * 13;
        const blade = [[tipX + 3 - dx, tipY - dy], [tipX + 3 + dx, tipY + dy]];
        line([[tipX, tipY], [tipX + 3, tipY]], '#bad0d9', 2.5);
        line(blade, ink, 6); line(blade, '#a5c5cd', 4);
        line(blade.map(([x, y]) => [x + 1.5, y]), '#63bcc5', 2);
    } finally { ctx.restore(); }
}
