import { signOut } from "@workos-inc/authkit-nextjs";

export const GET = async () => {
  return signOut();
};
