import { log, createLogger } from "@developerehsan/nextjs-logger";
import { LoggerPlayground } from "./logger-playground";

const pageLog = createLogger({ namespace: "home-page", });

export default async function Home() {
  // A Server Component logging directly in its body — synchronous,
  // server-only, no useEffect, no "is the logger ready" check. This
  // writes straight to the terminal the instant this page renders.
  log.info("Rendering home page");
  pageLog.debug("Home page render body reached");

  // Simulates real server-side work you'd typically log around.
  await new Promise((resolve) => setTimeout(resolve, 10));
  pageLog.info("Home page data ready");

  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-col gap-10 py-16 px-6 sm:px-16 bg-white dark:bg-black">
        <div className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
            @developerehsan/nextjs-logger
          </h1>
          <p className="max-w-xl text-base leading-7 text-zinc-600 dark:text-zinc-400">
            This page already produced two log lines on the server — in your{" "}
            <strong>terminal</strong>, not this browser&apos;s DevTools console. Everything
            below is interactive; open the terminal running <code>next dev</code> and try
            each section.
          </p>
        </div>

        <LoggerPlayground />
      </main>
    </div>
  );
}
