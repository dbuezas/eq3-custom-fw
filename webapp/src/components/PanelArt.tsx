/**
 * The thermostat's glass: one element per real LCD segment, traced off a photo of the device.
 *
 * **THIS IS THE DRAWING. Edit it here** `[owner]` — nudge a coordinate and it is nudged. Nothing
 * generates this file and nothing checks it against anything: a component you can edit beats a
 * pipeline you have to run.
 *
 * **THE IDS ARE THE CONTRACT** with the firmware's segment tables (`bar0..23`, `d<slot>.<a..g>`
 * with SLOT 0 THE RIGHTMOST CELL, `day0..6` Monday first, and the icons by name). Those tables are
 * read out of the device, so a renamed element here is a segment that silently never lights —
 * `src/sections/panel.test.tsx` holds one of each kind.
 *
 * `cls(id, base)` decides what a lit segment looks like, and lives in the caller. Nothing about
 * temperature, weekdays or bit addresses belongs in this file.
 */
export function PanelArt({ cls }: { cls: (id: string, base: string) => string }) {
  return (
    <svg viewBox="0 0 1000 580" className="lcd">
      <rect x="0" y="0" width="1000" height="580" rx="16" className="glass" />
      <rect id="bar0" x="65.0" y="46" width="31.1" height="36" className={cls('bar0', 'seg')} />
      <rect id="bar1" x="102.1" y="46" width="31.1" height="36" className={cls('bar1', 'seg')} />
      <rect id="bar2" x="139.2" y="46" width="31.1" height="36" className={cls('bar2', 'seg')} />
      <rect id="bar3" x="176.4" y="46" width="31.1" height="36" className={cls('bar3', 'seg')} />
      <rect id="bar4" x="213.5" y="46" width="31.1" height="36" className={cls('bar4', 'seg')} />
      <rect id="bar5" x="250.6" y="46" width="31.1" height="36" className={cls('bar5', 'seg')} />
      <rect id="bar6" x="287.8" y="46" width="31.1" height="36" className={cls('bar6', 'seg')} />
      <rect id="bar7" x="324.9" y="46" width="31.1" height="36" className={cls('bar7', 'seg')} />
      <rect id="bar8" x="362.0" y="46" width="31.1" height="36" className={cls('bar8', 'seg')} />
      <rect id="bar9" x="399.1" y="46" width="31.1" height="36" className={cls('bar9', 'seg')} />
      <rect id="bar10" x="436.2" y="46" width="31.1" height="36" className={cls('bar10', 'seg')} />
      <rect id="bar11" x="473.4" y="46" width="31.1" height="36" className={cls('bar11', 'seg')} />
      <rect id="bar12" x="510.5" y="46" width="31.1" height="36" className={cls('bar12', 'seg')} />
      <rect id="bar13" x="547.6" y="46" width="31.1" height="36" className={cls('bar13', 'seg')} />
      <rect id="bar14" x="584.8" y="46" width="31.1" height="36" className={cls('bar14', 'seg')} />
      <rect id="bar15" x="621.9" y="46" width="31.1" height="36" className={cls('bar15', 'seg')} />
      <rect id="bar16" x="659.0" y="46" width="31.1" height="36" className={cls('bar16', 'seg')} />
      <rect id="bar17" x="696.1" y="46" width="31.1" height="36" className={cls('bar17', 'seg')} />
      <rect id="bar18" x="733.2" y="46" width="31.1" height="36" className={cls('bar18', 'seg')} />
      <rect id="bar19" x="770.4" y="46" width="31.1" height="36" className={cls('bar19', 'seg')} />
      <rect id="bar20" x="807.5" y="46" width="31.1" height="36" className={cls('bar20', 'seg')} />
      <rect id="bar21" x="844.6" y="46" width="31.1" height="36" className={cls('bar21', 'seg')} />
      <rect id="bar22" x="881.8" y="46" width="31.1" height="36" className={cls('bar22', 'seg')} />
      <rect id="bar23" x="918.9" y="46" width="31.1" height="36" className={cls('bar23', 'seg')} />
      <g id="hour-ticks" className={cls('hour-ticks', 'seg lbl')}>
        <text x="65" y="118" fontSize="30" textAnchor="middle">
          0
        </text>
        <text x="286" y="118" fontSize="30" textAnchor="middle">
          6
        </text>
        <text x="508" y="118" fontSize="30" textAnchor="middle">
          12
        </text>
        <text x="729" y="118" fontSize="30" textAnchor="middle">
          18
        </text>
        <text x="950" y="118" fontSize="30" textAnchor="middle">
          24
        </text>
      </g>
      <polygon id="d3.a" points="223.16,156 232.16,147.0 303.84000000000003,147.0 312.84000000000003,156 303.84000000000003,165.0 232.16,165.0" className={cls('d3.a', 'seg')} />
      <polygon id="d3.b" points="324,167.16 333.0,176.16 333.0,282.91999999999996 324,291.91999999999996 315.0,282.91999999999996 315.0,176.16" className={cls('d3.b', 'seg')} />
      <polygon id="d3.c" points="324,303.08 333.0,312.08 333.0,418.84 324,427.84 315.0,418.84 315.0,312.08" className={cls('d3.c', 'seg')} />
      <polygon id="d3.d" points="223.16,439 232.16,430.0 303.84000000000003,430.0 312.84000000000003,439 303.84000000000003,448.0 232.16,448.0" className={cls('d3.d', 'seg')} />
      <polygon id="d3.e" points="212,303.08 221.0,312.08 221.0,418.84 212,427.84 203.0,418.84 203.0,312.08" className={cls('d3.e', 'seg')} />
      <polygon id="d3.f" points="212,167.16 221.0,176.16 221.0,282.91999999999996 212,291.91999999999996 203.0,282.91999999999996 203.0,176.16" className={cls('d3.f', 'seg')} />
      <polygon id="d3.g" points="223.16,297.5 232.16,288.5 303.84000000000003,288.5 312.84000000000003,297.5 303.84000000000003,306.5 232.16,306.5" className={cls('d3.g', 'seg')} />
      <polygon id="d2.a" points="393.16,156 402.16,147.0 473.84000000000003,147.0 482.84000000000003,156 473.84000000000003,165.0 402.16,165.0" className={cls('d2.a', 'seg')} />
      <polygon id="d2.b" points="494,167.16 503.0,176.16 503.0,282.91999999999996 494,291.91999999999996 485.0,282.91999999999996 485.0,176.16" className={cls('d2.b', 'seg')} />
      <polygon id="d2.c" points="494,303.08 503.0,312.08 503.0,418.84 494,427.84 485.0,418.84 485.0,312.08" className={cls('d2.c', 'seg')} />
      <polygon id="d2.d" points="393.16,439 402.16,430.0 473.84000000000003,430.0 482.84000000000003,439 473.84000000000003,448.0 402.16,448.0" className={cls('d2.d', 'seg')} />
      <polygon id="d2.e" points="382,303.08 391.0,312.08 391.0,418.84 382,427.84 373.0,418.84 373.0,312.08" className={cls('d2.e', 'seg')} />
      <polygon id="d2.f" points="382,167.16 391.0,176.16 391.0,282.91999999999996 382,291.91999999999996 373.0,282.91999999999996 373.0,176.16" className={cls('d2.f', 'seg')} />
      <polygon id="d2.g" points="393.16,297.5 402.16,288.5 473.84000000000003,288.5 482.84000000000003,297.5 473.84000000000003,306.5 402.16,306.5" className={cls('d2.g', 'seg')} />
      <polygon id="d1.a" points="563.16,156 572.16,147.0 643.8399999999999,147.0 652.8399999999999,156 643.8399999999999,165.0 572.16,165.0" className={cls('d1.a', 'seg')} />
      <polygon id="d1.b" points="664,167.16 673.0,176.16 673.0,282.91999999999996 664,291.91999999999996 655.0,282.91999999999996 655.0,176.16" className={cls('d1.b', 'seg')} />
      <polygon id="d1.c" points="664,303.08 673.0,312.08 673.0,418.84 664,427.84 655.0,418.84 655.0,312.08" className={cls('d1.c', 'seg')} />
      <polygon id="d1.d" points="563.16,439 572.16,430.0 643.8399999999999,430.0 652.8399999999999,439 643.8399999999999,448.0 572.16,448.0" className={cls('d1.d', 'seg')} />
      <polygon id="d1.e" points="552,303.08 561.0,312.08 561.0,418.84 552,427.84 543.0,418.84 543.0,312.08" className={cls('d1.e', 'seg')} />
      <polygon id="d1.f" points="552,167.16 561.0,176.16 561.0,282.91999999999996 552,291.91999999999996 543.0,282.91999999999996 543.0,176.16" className={cls('d1.f', 'seg')} />
      <polygon id="d1.g" points="563.16,297.5 572.16,288.5 643.8399999999999,288.5 652.8399999999999,297.5 643.8399999999999,306.5 572.16,306.5" className={cls('d1.g', 'seg')} />
      <polygon id="d0.a" points="733.16,156 742.16,147.0 813.8399999999999,147.0 822.8399999999999,156 813.8399999999999,165.0 742.16,165.0" className={cls('d0.a', 'seg')} />
      <polygon id="d0.b" points="834,167.16 843.0,176.16 843.0,282.91999999999996 834,291.91999999999996 825.0,282.91999999999996 825.0,176.16" className={cls('d0.b', 'seg')} />
      <polygon id="d0.c" points="834,303.08 843.0,312.08 843.0,418.84 834,427.84 825.0,418.84 825.0,312.08" className={cls('d0.c', 'seg')} />
      <polygon id="d0.d" points="733.16,439 742.16,430.0 813.8399999999999,430.0 822.8399999999999,439 813.8399999999999,448.0 742.16,448.0" className={cls('d0.d', 'seg')} />
      <polygon id="d0.e" points="722,303.08 731.0,312.08 731.0,418.84 722,427.84 713.0,418.84 713.0,312.08" className={cls('d0.e', 'seg')} />
      <polygon id="d0.f" points="722,167.16 731.0,176.16 731.0,282.91999999999996 722,291.91999999999996 713.0,282.91999999999996 713.0,176.16" className={cls('d0.f', 'seg')} />
      <polygon id="d0.g" points="733.16,297.5 742.16,288.5 813.8399999999999,288.5 822.8399999999999,297.5 813.8399999999999,306.5 742.16,306.5" className={cls('d0.g', 'seg')} />
      <g id="colon" className={cls('colon', 'seg')}>
        <circle cx="522" cy="257" r="9" />
        <circle cx="522" cy="345" r="9" />
      </g>
      <circle id="dp-after-2" cx="514" cy="431" r="9" className={cls('dp-after-2', 'seg')} />
      <circle id="dp-after-3" cx="685" cy="431" r="9" className={cls('dp-after-3', 'seg')} />
      <text id="day0" x="236" y="512" fontSize="34" textAnchor="middle" className={cls('day0', 'seg lbl')}>
        Mo
      </text>
      <text id="day1" x="318" y="512" fontSize="34" textAnchor="middle" className={cls('day1', 'seg lbl')}>
        Tu
      </text>
      <text id="day2" x="400" y="512" fontSize="34" textAnchor="middle" className={cls('day2', 'seg lbl')}>
        We
      </text>
      <text id="day3" x="482" y="512" fontSize="34" textAnchor="middle" className={cls('day3', 'seg lbl')}>
        Th
      </text>
      <text id="day4" x="564" y="512" fontSize="34" textAnchor="middle" className={cls('day4', 'seg lbl')}>
        Fr
      </text>
      <text id="day5" x="646" y="512" fontSize="34" textAnchor="middle" className={cls('day5', 'seg lbl')}>
        Sa
      </text>
      <text id="day6" x="728" y="512" fontSize="34" textAnchor="middle" className={cls('day6', 'seg lbl')}>
        Su
      </text>
      <g id="sun" style={{ fill: "none" }} className={cls('sun', 'seg')}>
        <circle cx="92" cy="198" r="13" strokeWidth="6" />
        <line x1="92" y1="178" x2="92" y2="170" strokeWidth="6" strokeLinecap="round" transform="rotate(0 92 198)" />
        <line x1="92" y1="178" x2="92" y2="170" strokeWidth="6" strokeLinecap="round" transform="rotate(45 92 198)" />
        <line x1="92" y1="178" x2="92" y2="170" strokeWidth="6" strokeLinecap="round" transform="rotate(90 92 198)" />
        <line x1="92" y1="178" x2="92" y2="170" strokeWidth="6" strokeLinecap="round" transform="rotate(135 92 198)" />
        <line x1="92" y1="178" x2="92" y2="170" strokeWidth="6" strokeLinecap="round" transform="rotate(180 92 198)" />
        <line x1="92" y1="178" x2="92" y2="170" strokeWidth="6" strokeLinecap="round" transform="rotate(225 92 198)" />
        <line x1="92" y1="178" x2="92" y2="170" strokeWidth="6" strokeLinecap="round" transform="rotate(270 92 198)" />
        <line x1="92" y1="178" x2="92" y2="170" strokeWidth="6" strokeLinecap="round" transform="rotate(315 92 198)" />
      </g>
      <path id="moon" d="M 97 281 A 20 20 0 1 0 97 319 A 15 15 0 1 1 97 281 Z" className={cls('moon', 'seg')} />
      <g id="window" style={{ fill: "none" }} strokeWidth="5" className={cls('window', 'seg')}>
        <rect x="139" y="262" width="47" height="50" />
        <path d="M 152 278 L 186 269 L 186 313 L 152 324 Z" />
      </g>
      <text id="Auto" x="128" y="382" fontSize="30" textAnchor="middle" className={cls('Auto', 'seg lbl')}>
        Auto
      </text>
      <text id="Manu" x="128" y="420" fontSize="30" textAnchor="middle" className={cls('Manu', 'seg lbl')}>
        Manu
      </text>
      <circle id="degree" style={{ fill: "none" }} cx="922" cy="172" r="12" strokeWidth="6" className={cls('degree', 'seg')} />
      <text id="pct" x="918" y="418" fontSize="42" textAnchor="middle" className={cls('pct', 'seg lbl')}>
        %
      </text>
      <g id="suitcase" style={{ fill: "none" }} strokeWidth="5" className={cls('suitcase', 'seg')}>
        <rect x="70" y="496" width="40" height="28" />
        <path d="M 82 496 L 82 488 L 98 488 L 98 496" />
      </g>
      <g id="battery" className={cls('battery', 'seg')}>
        <rect style={{ fill: "none" }} x="876" y="495" width="48" height="26" strokeWidth="5" />
        <rect x="924" y="502" width="7" height="12" />
        <rect x="882" y="501" width="16" height="14" />
      </g>
    </svg>
  )
}
