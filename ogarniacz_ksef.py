"""Ogarniacz KSEF - dopasowywanie faktur z KSEF od księgowej do ewidencji operacji finansowych."""
import re
import tkinter as tk
import unicodedata
from collections import Counter, defaultdict
from tkinter import filedialog, messagebox, ttk

from openpyxl import load_workbook

MONTHS = ["styczen", "luty", "marzec", "kwiecien", "maj", "czerwiec",
          "lipiec", "sierpien", "wrzesien", "pazdziernik", "listopad", "grudzien"]


def norm(text):
    t = unicodedata.normalize("NFD", str(text).lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return t.replace("ł", "l")


def to_cents(v):
    """Zamienia wartość komórki na grosze (int) lub None."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return round(float(v) * 100)
    s = re.sub(r"[^\d,.\-]", "", str(v).replace("\xa0", ""))
    if not s:
        return None
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        return round(float(s) * 100)
    except ValueError:
        return None


def ksef_month(nr):
    m = re.search(r"-(\d{4})(\d{2})(\d{2})-", str(nr or ""))
    if m and 1 <= int(m.group(2)) <= 12:
        return int(m.group(2))
    return None


def read_invoices(path):
    wb = load_workbook(path, data_only=True, read_only=True)
    ws = wb.worksheets[0]
    out = []
    for row in ws.iter_rows(min_row=2, max_col=7, values_only=True):
        row = list(row) + [None] * (7 - len(row))
        if all(c is None for c in row):
            continue
        out.append({"row": row, "date": row[0], "number": row[1], "ksef": row[2],
                    "contractor": row[3], "cents": to_cents(row[4])})
    wb.close()
    return out


def read_ledger(path):
    """Zwraca {miesiąc: {'przychod': {grosze: [(lp, firma)]}, 'koszt': {...}}}."""
    wb = load_workbook(path, data_only=True, read_only=True)
    result = {}
    for ws in wb.worksheets:
        name = norm(ws.title)
        month = next((i + 1 for i, m in enumerate(MONTHS) if m in name), None)
        if month is None:
            continue
        data = {"przychod": defaultdict(list), "koszt": defaultdict(list)}
        for row in ws.iter_rows(min_row=6, max_col=17, values_only=True):
            row = list(row) + [None] * (17 - len(row))
            lp, firma, m_col, q_col = row[0], row[4], row[12], row[16]
            if lp is None:
                continue
            for key, val in (("przychod", m_col), ("koszt", q_col)):
                c = to_cents(val)
                if c:
                    data[key][abs(c)].append((lp, firma))
        result[month] = data
    wb.close()
    return result


def match(invoices, ledger):
    counts = Counter(i["cents"] for i in invoices if i["cents"] is not None)
    matched, unmatched = [], []
    for inv in invoices:
        c = inv["cents"]
        found = []
        month = ksef_month(inv["ksef"])
        if c is not None and counts[c] == 1 and month in ledger:
            key = "przychod" if c < 0 else "koszt"
            found = ledger[month][key].get(abs(c), [])
        if len(found) == 1:
            lp, firma = found[0]
            matched.append((lp, f"{c / 100:.2f}", inv["ksef"], inv["contractor"], firma))
        else:
            unmatched.append(inv)
    return matched, unmatched


def fmt(v):
    if v is None:
        return ""
    if hasattr(v, "strftime"):
        return v.strftime("%Y-%m-%d")
    return str(v)


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Ogarniacz KSEF")
        self.geometry("1100x750")
        self.inv_path = tk.StringVar()
        self.led_path = tk.StringVar()

        top = ttk.Frame(self, padding=8)
        top.pack(fill="x")
        for r, (label, var) in enumerate([("Lista faktur od księgowej:", self.inv_path),
                                          ("Ewidencja operacji finansowych:", self.led_path)]):
            ttk.Label(top, text=label).grid(row=r, column=0, sticky="w")
            ttk.Entry(top, textvariable=var, width=80).grid(row=r, column=1, padx=6, pady=2)
            ttk.Button(top, text="Wybierz...",
                       command=lambda v=var: self.browse(v)).grid(row=r, column=2)
        ttk.Button(top, text="Dopasuj", command=self.run).grid(row=2, column=1, pady=6)

        self.t1, self.c1 = self.make_table(
            "Faktury zmatchowane", ("lp", "kwota", "ksef", "kontrahent", "firma"),
            ("Lp", "Kwota brutto", "Nr KSEF", "Kontrahent", "Firma (ewidencja)"))
        self.t2, self.c2 = self.make_table(
            "Faktury niezmatchowane", ("data", "nr", "ksef", "kontrahent", "kwota"),
            ("Data", "Nr faktury", "Nr KSEF", "Kontrahent", "Kwota brutto"))

    def make_table(self, title, cols, heads):
        frame = ttk.LabelFrame(self, text=title, padding=4)
        frame.pack(fill="both", expand=True, padx=8, pady=4)
        tree = ttk.Treeview(frame, columns=cols, show="headings", height=8)
        for c, h in zip(cols, heads):
            tree.heading(c, text=h)
            tree.column(c, width=150, anchor="w")
        sb = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=sb.set)
        tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="left", fill="y")
        count = ttk.Label(self, text="Liczba rekordów: 0")
        count.pack(anchor="w", padx=12)
        return tree, count

    def browse(self, var):
        p = filedialog.askopenfilename(filetypes=[("Excel", "*.xlsx *.xlsm")])
        if p:
            var.set(p)

    def run(self):
        if not self.inv_path.get() or not self.led_path.get():
            messagebox.showwarning("Brak plików", "Wybierz oba pliki.")
            return
        try:
            invoices = read_invoices(self.inv_path.get())
            ledger = read_ledger(self.led_path.get())
            matched, unmatched = match(invoices, ledger)
        except Exception as e:
            messagebox.showerror("Błąd", str(e))
            return
        if not ledger:
            messagebox.showwarning("Ewidencja", "Nie znaleziono arkuszy z nazwami miesięcy.")
        for tree in (self.t1, self.t2):
            tree.delete(*tree.get_children())
        for m in matched:
            self.t1.insert("", "end", values=[fmt(x) for x in m])
        for i in unmatched:
            r = i["row"]
            self.t2.insert("", "end", values=[fmt(r[0]), fmt(r[1]), fmt(r[2]), fmt(r[3]), fmt(r[4])])
        self.c1.config(text=f"Liczba rekordów: {len(matched)}")
        self.c2.config(text=f"Liczba rekordów: {len(unmatched)}")


if __name__ == "__main__":
    App().mainloop()
