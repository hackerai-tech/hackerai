import { Metadata } from "next";
import { SharedChatView } from "./SharedChatView";

type Props = {
  params: Promise<{ shareId: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { shareId } = await params;

  return {
    title: "Shared Chat | HackerAI",
    description: "View a shared conversation from HackerAI",
    robots: "noindex, nofollow", // Don't index shared chats
  };
}

export default async function SharedChatPage({ params }: Props) {
  const { shareId } = await params;

  return <SharedChatView shareId={shareId} />;
}
