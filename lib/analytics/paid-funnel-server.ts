import { v5 as uuidv5 } from "uuid";
import { checkoutStartedInsertId } from "./paid-funnel";

export function checkoutStartedEventUuid(checkoutAttemptId: string): string {
  return uuidv5(checkoutStartedInsertId(checkoutAttemptId), uuidv5.URL);
}
