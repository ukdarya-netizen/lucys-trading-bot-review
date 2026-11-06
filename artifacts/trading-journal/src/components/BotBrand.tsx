export type BotSource = "cab" | "nihilist";

export const BOT_BRAND_NAMES: Record<BotSource, string> = {
  cab: "Crypto Alts Bullet",
  nihilist: "Nihilyst Crypto Trading",
};

const BOT_AVATARS: Record<BotSource, string> = {
  cab: `${import.meta.env.BASE_URL}brands/crypto-alts-bullet.png`,
  nihilist: `${import.meta.env.BASE_URL}brands/nihilyst-crypto-trading.jpeg`,
};

/** Bot mark and its distinct display typography; source IDs stay unchanged. */
export function BotBrand({
  source,
  size = "sm",
}: {
  source: BotSource;
  size?: "xs" | "sm" | "md";
}) {
  const name = BOT_BRAND_NAMES[source];
  return (
    <span className={`bot-brand bot-brand--${source} bot-brand--${size}`} title={name}>
      <img
        src={BOT_AVATARS[source]}
        alt=""
        aria-hidden="true"
        className="bot-brand-avatar"
        draggable={false}
      />
      <span className="bot-brand-name" aria-label={name}>{name}</span>
    </span>
  );
}
