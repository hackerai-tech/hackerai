"use client";

import { useState } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

const HACKING_QUESTIONS = [
  (name?: string) =>
    name ? `What should we hack, ${name}?` : "What should we hack?",
  (name?: string) => (name ? `Got an idea, ${name}?` : "Got an idea?"),
  (name?: string) =>
    name ? `What are we testing today, ${name}?` : "What are we testing today?",
  (name?: string) =>
    name ? `Where do we start, ${name}?` : "Where do we start?",
  (name?: string) =>
    name ? `What's our target today, ${name}?` : "What's our target today?",
  (name?: string) =>
    name ? `What's on the scope today, ${name}?` : "What's on the scope today?",
  (name?: string) =>
    name
      ? `What are we exploiting today, ${name}?`
      : "What are we exploiting today?",
  (name?: string) =>
    name ? `Ready to find some vulns, ${name}?` : "Ready to find some vulns?",
  (name?: string) =>
    name ? `What's on your mind, ${name}?` : "What's on your mind?",
];

export const HackingSuggestions = () => {
  const { user } = useAuth();
  const name = user?.firstName || undefined;
  const [questionFn] = useState(
    () =>
      HACKING_QUESTIONS[Math.floor(Math.random() * HACKING_QUESTIONS.length)],
  );

  return (
    <div className="relative mb-4 flex flex-col items-center px-4 text-center md:mb-6">
      <h1 className="flex items-center gap-1 text-xl font-medium leading-none text-foreground sm:text-2xl md:gap-0 md:text-3xl">
        <span className="min-h-6 pt-0.5 tracking-tight sm:min-h-7 md:min-h-8 md:pt-0">
          {questionFn(name)}
        </span>
      </h1>
    </div>
  );
};
