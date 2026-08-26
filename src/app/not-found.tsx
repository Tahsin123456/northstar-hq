import Link from "next/link";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-2xl items-center px-6">
      <div className="w-full rounded-lg border border-border bg-surface">
        <EmptyState
          icon={<Compass />}
          title="Page not found"
          description="That page doesn't exist. It may have been removed, or the link may be wrong."
          action={
            <Button variant="primary" asChild>
              <Link href="/">Back to overview</Link>
            </Button>
          }
        />
      </div>
    </div>
  );
}
