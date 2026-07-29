import { PageHeader } from "@/components/PageHeader";
import { ReviewList } from "@/components/ReviewList";
import { getProposedLinks } from "@/db/queries";
import { AUTO_CONFIRM, PROPOSE_FLOOR } from "@/lib/match";
import { pct } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Review() {
  const links = await getProposedLinks(150);

  return (
    <div className="mx-auto max-w-[1000px] px-8 py-8">
      <PageHeader
        title="Review"
        lede={
          <>
            What the matcher thinks paid for what, sorted by how sure it is. Anything above{" "}
            <span className="tnum">{pct(AUTO_CONFIRM)}</span> was confirmed automatically and
            isn&rsquo;t here; anything below <span className="tnum">{pct(PROPOSE_FLOOR)}</span> was
            discarded rather than shown, because a queue full of guesses trains you to stop reading it.
          </>
        }
      />

      <div className="pt-6">
        <ReviewList links={links} />
      </div>
    </div>
  );
}
