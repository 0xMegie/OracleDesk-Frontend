// Reuse Intl's formatter across rows and batches; locale setup is expensive.
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export const formatFeedTime = (value: string | number) => clock.format(new Date(value));
