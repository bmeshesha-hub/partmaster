#!/usr/bin/env python3
"""Extract Partmaster vehicle reference CSVs from Vehicle Mapping ePID.xlsx."""

import csv
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def column_index(cell_reference):
    letters = re.match(r"[A-Z]+", cell_reference or "A").group(0)
    result = 0
    for letter in letters:
        result = result * 26 + ord(letter) - 64
    return result - 1


def workbook_reader(path):
    archive = zipfile.ZipFile(path)
    shared_strings = []
    if "xl/sharedStrings.xml" in archive.namelist():
        for _, node in ET.iterparse(archive.open("xl/sharedStrings.xml"), events=("end",)):
            if node.tag.endswith("}si"):
                shared_strings.append("".join(text.text or "" for text in node.iter() if text.tag.endswith("}t")))
                node.clear()

    workbook = ET.parse(archive.open("xl/workbook.xml")).getroot()
    relationships = ET.parse(archive.open("xl/_rels/workbook.xml.rels")).getroot()
    targets = {relationship.attrib["Id"]: relationship.attrib["Target"] for relationship in relationships.findall(f"{{{REL_NS}}}Relationship")}
    sheet_paths = {}
    for sheet in workbook.find(f"{{{MAIN_NS}}}sheets"):
        relationship_id = sheet.attrib[f"{{{OFFICE_REL_NS}}}id"]
        sheet_paths[sheet.attrib["name"]] = "xl/worksheets/" + targets[relationship_id].split("/")[-1]

    def read_rows(sheet_name):
        if sheet_name not in sheet_paths:
            raise ValueError(f"Required worksheet not found: {sheet_name}")
        for _, node in ET.iterparse(archive.open(sheet_paths[sheet_name]), events=("end",)):
            if not node.tag.endswith("}row"):
                continue
            values = []
            for cell in node.findall(f"{{{MAIN_NS}}}c"):
                index = column_index(cell.attrib.get("r"))
                while len(values) <= index:
                    values.append("")
                value_node = cell.find(f"{{{MAIN_NS}}}v")
                inline_node = cell.find(f"{{{MAIN_NS}}}is")
                if inline_node is not None:
                    value = "".join(text.text or "" for text in inline_node.iter() if text.tag.endswith("}t"))
                elif value_node is not None:
                    raw_value = value_node.text or ""
                    value = shared_strings[int(raw_value)] if cell.attrib.get("t") == "s" and raw_value else raw_value
                else:
                    value = ""
                values[index] = value.strip()
            node.clear()
            yield values

    return archive, read_rows


def main():
    repository_root = Path(__file__).resolve().parents[1]
    input_path = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else repository_root / "local_data/inbox/Vehicle Mapping ePID.xlsx"
    output_directory = Path(sys.argv[2]).expanduser().resolve() if len(sys.argv) > 2 else repository_root / "local_data/reference"
    output_directory.mkdir(parents=True, exist_ok=True)

    archive, read_rows = workbook_reader(input_path)
    try:
        master_by_epid = {}
        wide_rows = read_rows("epid to VCDB ARI NADA")
        next(wide_rows, None)
        next(wide_rows, None)
        for row in wide_rows:
            padded = row + [""] * (6 - len(row))
            epid = padded[0]
            if not epid:
                continue
            vehicle = tuple(padded[1:6])
            existing = master_by_epid.get(epid)
            if existing is not None and existing != vehicle:
                raise ValueError(f"ePID {epid} maps to more than one MPSOV vehicle.")
            master_by_epid[epid] = vehicle

        aliases = set()
        source_rows = read_rows("epid to MPSOV Source")
        next(source_rows, None)
        next(source_rows, None)
        for row in source_rows:
            padded = row + [""] * (11 - len(row))
            if padded[0] and padded[6]:
                aliases.add((padded[0], padded[6], padded[7], padded[8], padded[9], padded[10]))
    finally:
        archive.close()

    master_path = output_directory / "vehicle_master.csv"
    aliases_path = output_directory / "vehicle_source_aliases.csv"
    with master_path.open("w", newline="", encoding="utf-8") as output:
        writer = csv.writer(output)
        writer.writerow(["epid", "year", "make", "model", "trim", "vehicle_type"])
        for epid, vehicle in sorted(master_by_epid.items(), key=lambda item: int(item[0])):
            writer.writerow([epid, *vehicle])
    with aliases_path.open("w", newline="", encoding="utf-8") as output:
        writer = csv.writer(output)
        writer.writerow(["epid", "source", "year", "make", "model", "trim"])
        for alias in sorted(aliases, key=lambda item: (int(item[0]), item[1], item[2:])):
            writer.writerow(alias)

    print(f"Vehicle master: {len(master_by_epid):,} rows -> {master_path}")
    print(f"Source aliases: {len(aliases):,} rows -> {aliases_path}")


if __name__ == "__main__":
    main()
