import { createRoot } from "react-dom/client";
import { CalendarApp } from "@/components/calendar/CalendarApp";

createRoot(document.getElementById("app")!).render(<CalendarApp />);
