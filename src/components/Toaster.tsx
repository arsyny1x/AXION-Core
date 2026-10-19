import { CheckCircle2 } from "lucide-react";

export default function Toaster({ toast }: { toast: { id: number; message: string } | null }) {
  if (!toast) return null;
  return (
    <div className="toaster" key={toast.id}>
      <CheckCircle2 size={16} />
      <span>{toast.message}</span>
    </div>
  );
}
