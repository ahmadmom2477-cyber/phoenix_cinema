import { useLocation } from "wouter";
import { useLang } from "@/contexts/lang";

export default function NotFound() {
  const [, setLocation] = useLocation();
  const { t } = useLang();

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center max-w-md mx-auto">
        <div className="text-7xl font-serif font-bold text-primary/30 mb-4 select-none">404</div>
        <div className="text-5xl mb-6">🎬</div>
        <h1 className="text-2xl font-serif font-semibold text-white mb-3">
          {t("الصفحة غير موجودة", "Page Not Found")}
        </h1>
        <p className="text-muted-foreground leading-relaxed mb-8">
          {t(
            "الصفحة التي تبحث عنها غير موجودة أو تم نقلها.",
            "The page you're looking for doesn't exist or has been moved."
          )}
        </p>
        <button
          onClick={() => setLocation("/")}
          className="px-8 py-3 bg-primary text-primary-foreground rounded-full font-medium hover:bg-primary/90 transition-colors active:scale-95"
        >
          {t("العودة للرئيسية", "Back to Home")}
        </button>
      </div>
    </div>
  );
}
