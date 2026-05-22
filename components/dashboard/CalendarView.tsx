"use client";

import { useState, useEffect, useRef } from "react";
import { Calendar, dateFnsLocalizer, View } from "react-big-calendar";
import { format, parse, startOfWeek, getDay } from "date-fns";
import { enUS } from "date-fns/locale";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import { toCalendarDate, formatArizona } from "@/lib/timezone";
import "react-big-calendar/lib/css/react-big-calendar.css";

const locales = {
  "en-US": enUS,
};

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales,
});

interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  type: "call" | "first_session" | "session" | "group_session" | "reminder";
  resource?: {
    parent_name?: string;
    player_names?: string[];
    location?: string;
    status?: string;
    reminder_type?: string;
    notes?: string;
    price?: number | null;
    player_count?: number;
    prospect_count?: number;
    max_players?: number;
    originalStart?: Date;
    originalEnd?: Date;
  };
}

interface DashboardData {
  upcomingCalls: Array<{
    id: number;
    name: string;
    call_date_time: string | null;
    phone?: string;
  }>;
  upcomingFirstSessions: Array<{
    id: number;
    parent_name: string;
    player_names?: string[];
    session_date: string;
    location?: string;
    status?: string;
  }>;
  upcomingSessions: Array<{
    id: number;
    parent_name: string;
    title?: string | null;
    player_names?: string[];
    session_date: string;
    session_end_date?: string | null;
    location?: string;
    status?: string;
  }>;
  upcomingGroupSessions: Array<{
    id: number;
    title: string;
    description?: string | null;
    session_date: string;
    session_date_end?: string | null;
    location?: string | null;
    price?: number | null;
    max_players?: number;
    player_count?: number;
    prospect_count?: number;
  }>;
  upcomingReminders: Array<{
    id: number;
    parent_name: string;
    reminder_type: string;
    due_at: string;
    notes?: string;
  }>;
}

export default function CalendarView() {
  const [view, setView] = useState<View>("month");
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const calendarWrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchCalendarData();
  }, []);

  // Reposition the "+N more" overlay so it never goes off-screen
  useEffect(() => {
    const wrapper = calendarWrapperRef.current;
    if (!wrapper) return;

    const repositionOverlay = () => {
      const overlay = wrapper.querySelector<HTMLElement>(".rbc-overlay");
      if (!overlay) return;

      // Reset any previous positioning so we can measure naturally
      overlay.style.position = "fixed";
      overlay.style.transform = "none";

      const rect = overlay.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;

      let newLeft = rect.left;
      let newTop = rect.top;

      // Clamp horizontally
      if (newLeft + rect.width > vw - pad) newLeft = vw - pad - rect.width;
      if (newLeft < pad) newLeft = pad;

      // Clamp vertically
      if (newTop + rect.height > vh - pad) newTop = vh - pad - rect.height;
      if (newTop < pad) newTop = pad;

      overlay.style.left = `${newLeft}px`;
      overlay.style.top = `${newTop}px`;
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node instanceof HTMLElement && (node.classList.contains("rbc-overlay") || node.querySelector?.(".rbc-overlay"))) {
            // Small delay to let the browser finish layout
            requestAnimationFrame(repositionOverlay);
          }
        }
      }
    });

    observer.observe(wrapper, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const fetchCalendarData = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/dashboard");
      if (res.ok) {
        const data: DashboardData = await res.json();
        const calendarEvents: CalendarEvent[] = [];

        // Display order when multiple events share the same start time.
        // Keep timestamps exact (no ms hacks), sort in-memory instead.
        const SORT_PRIORITY: Record<string, number> = {
          session: 0,
          group_session: 1,
          first_session: 2,
          call: 3,
          session_reminder: 4,
        };

        const getSortKey = (type: string): string => {
          if (type === "reminder") {
            return "session_reminder";
          }
          return type;
        };

        // Add calls (only those with a date set)
        // Convert all dates to Arizona time for display
        data.upcomingCalls?.forEach((call) => {
          if (!call.call_date_time) return; // Skip calls without a date
          const startDate = toCalendarDate(call.call_date_time);
          if (isNaN(startDate.getTime())) return; // Skip invalid dates
          const endDate = new Date(startDate.getTime() + 30 * 60000); // 30 min default
          calendarEvents.push({
            id: `call-${call.id}`,
            title: `📞 Call: ${call.name}`,
            start: startDate,
            end: endDate,
            type: "call",
            resource: {
              parent_name: call.name,
              originalStart: startDate,
              originalEnd: endDate,
            },
          });
        });

        // Add first sessions
        data.upcomingFirstSessions?.forEach((session) => {
          const startDate = toCalendarDate(session.session_date);
          const endDate = new Date(startDate.getTime() + 60 * 60000); // 1 hour default
          calendarEvents.push({
            id: `first-session-${session.id}`,
            title: `⭐ First Session: ${session.parent_name}`,
            start: startDate,
            end: endDate,
            type: "first_session",
            resource: {
              parent_name: session.parent_name,
              player_names: session.player_names,
              location: session.location,
              status: session.status,
              originalStart: startDate,
              originalEnd: endDate,
            },
          });
        });

        // Add regular sessions
        data.upcomingSessions?.forEach((session) => {
          const startDate = toCalendarDate(session.session_date);
          const endDate = session.session_end_date
            ? toCalendarDate(session.session_end_date)
            : new Date(startDate.getTime() + 60 * 60000); // 1 hour default
          const sessionLabel = session.title?.trim() || session.parent_name;
          calendarEvents.push({
            id: `session-${session.id}`,
            title: `⚽ Session: ${sessionLabel}`,
            start: startDate,
            end: endDate,
            type: "session",
            resource: {
              parent_name: session.parent_name,
              player_names: session.player_names,
              location: session.location,
              status: session.status,
              originalStart: startDate,
              originalEnd: endDate,
            },
          });
        });

        data.upcomingGroupSessions?.forEach((session) => {
          const startDate = toCalendarDate(session.session_date);
          const endDate = session.session_date_end
            ? toCalendarDate(session.session_date_end)
            : new Date(startDate.getTime() + 60 * 60000);
          calendarEvents.push({
            id: `group-session-${session.id}`,
            title: session.title,
            start: startDate,
            end: endDate,
            type: "group_session",
            resource: {
              location: session.location || undefined,
              notes: session.description || undefined,
              price: session.price ?? null,
              player_count: session.player_count ?? 0,
              prospect_count: session.prospect_count ?? 0,
              max_players: session.max_players ?? 0,
              originalStart: startDate,
              originalEnd: endDate,
            },
          });
        });

        // Add ALL reminders for calendar
        data.upcomingReminders?.forEach((reminder) => {
          const dueDate = toCalendarDate(reminder.due_at);
          calendarEvents.push({
            id: `reminder-${reminder.id}`,
            title: `💬 Text: ${reminder.parent_name}`,
            start: dueDate,
            end: dueDate,
            type: "reminder",
            resource: {
              parent_name: reminder.parent_name,
              reminder_type: reminder.reminder_type,
              notes: reminder.notes,
              originalStart: dueDate,
              originalEnd: dueDate,
            },
          });
        });

        calendarEvents.sort((a, b) => {
          const aStart = (a.resource?.originalStart ?? a.start).getTime();
          const bStart = (b.resource?.originalStart ?? b.start).getTime();
          if (aStart !== bStart) return aStart - bStart;

          const aSortKey = getSortKey(a.type);
          const bSortKey = getSortKey(b.type);
          const aPriority = SORT_PRIORITY[aSortKey] ?? 99;
          const bPriority = SORT_PRIORITY[bSortKey] ?? 99;
          if (aPriority !== bPriority) return aPriority - bPriority;

          const aEnd = (a.resource?.originalEnd ?? a.end).getTime();
          const bEnd = (b.resource?.originalEnd ?? b.end).getTime();
          return aEnd - bEnd;
        });

        setEvents(calendarEvents);
      }
    } catch (error) {
      console.error("Error fetching calendar data:", error);
    } finally {
      setLoading(false);
    }
  };

  const eventStyleGetter = (event: CalendarEvent) => {
    let backgroundColor = "#3174ad";

    switch (event.type) {
      case "call":
        backgroundColor = "#f44336"; // Red
        break;
      case "first_session":
        backgroundColor = "#ff9800"; // Orange
        break;
      case "session":
        backgroundColor = "#4caf50"; // Green
        break;
      case "group_session":
        backgroundColor = "#f4511e"; // Deep orange
        break;
      case "reminder":
        backgroundColor = "#9c27b0";
        break;
    }

    return {
      style: {
        backgroundColor,
        borderRadius: "5px",
        opacity: 0.9,
        color: "white",
        border: "0px",
        display: "block",
      },
    };
  };

  const handleSelectEvent = (event: CalendarEvent) => {
    setSelectedEvent(event);
  };

  const getEventTypeLabel = (type: string) => {
    switch (type) {
      case "call":
        return "📞 Phone Call";
      case "first_session":
        return "⭐ First Session";
      case "session":
        return "⚽ Training Session";
      case "group_session":
        return "🟧 Group Session";
      case "reminder":
        return "💬 Session Text";
      default:
        return type;
    }
  };

  return (
    <Card>
      <CardContent>
        <Box sx={{ mb: 2 }}>
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              mb: 1.5,
            }}
          >
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Calendar View
            </Typography>
            <ToggleButtonGroup
              value={view}
              exclusive
              onChange={(e, newView) => newView && setView(newView)}
              size="small"
            >
              <ToggleButton value="day">Day</ToggleButton>
              <ToggleButton value="week">Week</ToggleButton>
              <ToggleButton value="month">Month</ToggleButton>
            </ToggleButtonGroup>
          </Box>
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              gap: 2,
              alignItems: "center",
              py: 1,
              px: 1.5,
              borderRadius: 1,
              bgcolor: "action.hover",
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
              <Box
                sx={{
                  width: 14,
                  height: 14,
                  borderRadius: "4px",
                  bgcolor: "#ff9800",
                }}
              />
              <Typography variant="body2" color="text.secondary">
                First session
              </Typography>
            </Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
              <Box
                sx={{
                  width: 14,
                  height: 14,
                  borderRadius: "4px",
                  bgcolor: "#4caf50",
                }}
              />
              <Typography variant="body2" color="text.secondary">
                Session
              </Typography>
            </Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
              <Box
                sx={{
                  width: 14,
                  height: 14,
                  borderRadius: "4px",
                  bgcolor: "#f4511e",
                }}
              />
              <Typography variant="body2" color="text.secondary">
                Group session
              </Typography>
            </Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
              <Box
                sx={{
                  width: 14,
                  height: 14,
                  borderRadius: "4px",
                  bgcolor: "#f44336",
                }}
              />
              <Typography variant="body2" color="text.secondary">
                Call
              </Typography>
            </Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
              <Box
                sx={{
                  width: 14,
                  height: 14,
                  borderRadius: "4px",
                  bgcolor: "#9c27b0",
                }}
              />
              <Typography variant="body2" color="text.secondary">
                Session text
              </Typography>
            </Box>
          </Box>
        </Box>

        {loading ? (
          <Typography color="text.secondary">Loading calendar...</Typography>
        ) : (
          <Box
            ref={calendarWrapperRef}
            sx={{
              height: 600,
              width: "100%",
              overflow: "visible",
              position: "relative",
              "& .rbc-calendar": {
                minWidth: "100%",
              },
              "& .rbc-month-view": {
                overflow: "visible",
              },
              "& .rbc-day-bg": {
                overflow: "visible",
              },
              "& .rbc-event": {
                padding: "2px 4px",
                fontSize: "0.85rem",
              },
              "& .rbc-show-more": {
                cursor: "pointer",
                color: "#1976d2",
                fontWeight: 600,
                "&:hover": {
                  textDecoration: "underline",
                },
              },
              "& .rbc-overlay": {
                minWidth: "300px !important",
                maxWidth: "400px !important",
                maxHeight: "60vh !important",
                overflow: "auto !important",
                boxShadow: "0 8px 24px rgba(0,0,0,0.25) !important",
                zIndex: 9999,
                backgroundColor: "white",
                border: "1px solid #ddd",
                borderRadius: "8px",
                padding: "12px",
              },
              "& .rbc-overlay-header": {
                position: "sticky",
                top: "-12px",
                backgroundColor: "white",
                zIndex: 1,
                borderBottom: "2px solid #e0e0e0",
                padding: "8px 0 12px 0",
                marginBottom: "8px",
                fontWeight: 700,
                fontSize: "1rem",
              },
              "& .rbc-event-content": {
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
            }}
          >
            <Calendar
              localizer={localizer}
              events={events}
              startAccessor="start"
              endAccessor="end"
              view={view}
              onView={setView}
              onSelectEvent={handleSelectEvent}
              eventPropGetter={eventStyleGetter}
              popup
              style={{ height: "100%", minHeight: "600px" }}
            />
          </Box>
        )}

        {/* Event Detail Dialog */}
        <Dialog
          open={!!selectedEvent}
          onClose={() => setSelectedEvent(null)}
          maxWidth="sm"
          fullWidth
        >
          {selectedEvent && (
            <>
              <DialogTitle>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  {getEventTypeLabel(selectedEvent.type)}
                  <Chip
                    label={selectedEvent.type.replace("_", " ").toUpperCase()}
                    size="small"
                    color={
                      selectedEvent.type === "call"
                        ? "error"
                        : selectedEvent.type === "group_session"
                        ? "warning"
                        : selectedEvent.type === "first_session"
                        ? "warning"
                        : selectedEvent.type === "session"
                        ? "success"
                        : "secondary"
                    }
                  />
                </Box>
              </DialogTitle>
              <DialogContent>
                <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {selectedEvent.resource?.parent_name && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        Parent
                      </Typography>
                      <Typography variant="body1" sx={{ fontWeight: 600 }}>
                        {selectedEvent.resource.parent_name}
                      </Typography>
                    </Box>
                  )}

                  {selectedEvent.resource?.player_names &&
                    selectedEvent.resource.player_names.length > 0 && (
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          Players
                        </Typography>
                        <Typography variant="body1">
                          {selectedEvent.resource.player_names.join(", ")}
                        </Typography>
                      </Box>
                    )}

                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Time (Arizona)
                    </Typography>
                    <Typography variant="body1">
                      {formatArizona(
                        selectedEvent.resource?.originalStart ??
                          selectedEvent.start,
                        "PPpp"
                      )}
                      {(selectedEvent.resource?.originalStart
                        ? selectedEvent.resource.originalStart.getTime()
                        : selectedEvent.start.getTime()) !==
                        (selectedEvent.resource?.originalEnd
                          ? selectedEvent.resource.originalEnd.getTime()
                          : selectedEvent.end.getTime()) &&
                        ` - ${formatArizona(
                          selectedEvent.resource?.originalEnd ??
                            selectedEvent.end,
                          "p"
                        )}`}
                    </Typography>
                  </Box>

                  {selectedEvent.resource?.location && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        Location
                      </Typography>
                      <Typography variant="body1">
                        {selectedEvent.resource.location}
                      </Typography>
                    </Box>
                  )}

                  {selectedEvent.type === "group_session" && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        Signups
                      </Typography>
                      <Typography variant="body1">
                        {selectedEvent.resource?.player_count ?? 0}
                        {selectedEvent.resource?.max_players
                          ? ` / ${selectedEvent.resource.max_players} paid`
                          : " paid"}
                        {typeof selectedEvent.resource?.prospect_count === "number"
                          ? `, ${selectedEvent.resource.prospect_count} prospect`
                          : ""}
                      </Typography>
                    </Box>
                  )}

                  {selectedEvent.type === "group_session" &&
                    typeof selectedEvent.resource?.price === "number" && (
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          Price
                        </Typography>
                        <Typography variant="body1">
                          ${selectedEvent.resource.price}
                        </Typography>
                      </Box>
                    )}

                  {selectedEvent.resource?.status && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        Status
                      </Typography>
                      <Typography variant="body1">
                        {selectedEvent.resource.status
                          .replace("_", " ")
                          .toUpperCase()}
                      </Typography>
                    </Box>
                  )}

                  {selectedEvent.resource?.reminder_type && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        Reminder Type
                      </Typography>
                      <Typography variant="body1">
                        {selectedEvent.resource.reminder_type.replace(
                          /_/g,
                          " "
                        )}
                      </Typography>
                    </Box>
                  )}

                  {selectedEvent.resource?.notes && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        Notes
                      </Typography>
                      <Typography variant="body1">
                        {selectedEvent.resource.notes}
                      </Typography>
                    </Box>
                  )}
                </Box>
              </DialogContent>
            </>
          )}
        </Dialog>
      </CardContent>
    </Card>
  );
}
