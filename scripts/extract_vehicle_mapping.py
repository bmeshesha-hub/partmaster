#!/usr/bin/env python3
"""Extract Partmaster vehicle reference CSVs from Vehicle Mapping ePID.xlsx."""

import csv
import json
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
    validation_path = output_directory / "vehicle_mapping_validation.json"
    validation = {
        "status": "failed",
        "source_workbook": str(input_path),
        "worksheets": ["epid to VCDB ARI NADA", "epid to MPSOV Source"],
        "master_rows": 0,
        "unique_epids": 0,
        "source_rows": 0,
        "unique_source_aliases": 0,
        "aliases_by_source": {},
        "canonical_source_rows": 0,
        "canonical_source_rows_missing_from_alias_tab": 0,
        "supplemental_source_aliases": 0,
        "alias_rows_missing_master": 0,
        "alias_rows_with_invalid_source": 0,
        "alias_rows_missing_vehicle_fields": 0,
        "master_conflicts": 0,
        "errors": [],
    }
    try:
        master_by_epid = {}
        wide_rows = read_rows("epid to VCDB ARI NADA")
        next(wide_rows, None)
        next(wide_rows, None)
        for row in wide_rows:
            padded = row + [""] * (16 - len(row))
            epid = padded[0]
            if not epid:
                continue
            vehicle = tuple(padded[1:6])
            existing = master_by_epid.get(epid)
            if existing is not None and existing != vehicle:
                validation["master_conflicts"] += 1
                validation["errors"].append(f"ePID {epid} maps to more than one MPSOV vehicle.")
            master_by_epid[epid] = vehicle

        canonical_aliases = set()
        # The wide tab is the canonical crosswalk. Its three source blocks
        # must be represented in the row-wise alias tab when populated.
        # Re-read the wide tab once to retain each source block for validation
        # without changing the compact CSV output format.
        wide_rows = read_rows("epid to VCDB ARI NADA")
        next(wide_rows, None)
        next(wide_rows, None)
        for row in wide_rows:
            padded = row + [""] * (16 - len(row))
            epid = padded[0]
            if not epid:
                continue
            for source, indexes in (("VCDB", (6, 7, 8, None)), ("ARI", (9, 10, 11, None)), ("NADA", (12, 13, 14, 15))):
                values = [padded[index] if index is not None else "" for index in indexes]
                if all(values[:3]):
                    canonical_aliases.add((epid, source, *values))

        aliases = set()
        source_rows = read_rows("epid to MPSOV Source")
        next(source_rows, None)
        next(source_rows, None)
        for row in source_rows:
            padded = row + [""] * (11 - len(row))
            if not any(padded):
                continue
            validation["source_rows"] += 1
            if padded[0] and padded[6]:
                aliases.add((padded[0], padded[6], padded[7], padded[8], padded[9], padded[10]))
            if padded[6] and padded[6] not in {"VCDB", "ARI", "NADA"}:
                validation["alias_rows_with_invalid_source"] += 1
            if padded[0] and padded[0] not in master_by_epid:
                validation["alias_rows_missing_master"] += 1
            if padded[0] and padded[6] and not all(padded[index] for index in (7, 8, 9)):
                validation["alias_rows_missing_vehicle_fields"] += 1
    finally:
        archive.close()

    aliases_by_source = {}
    for alias in aliases:
        aliases_by_source[alias[1]] = aliases_by_source.get(alias[1], 0) + 1
    missing_canonical_aliases = canonical_aliases - aliases
    supplemental_aliases = aliases - canonical_aliases
    validation.update({
        "master_rows": len(master_by_epid),
        "unique_epids": len(master_by_epid),
        "unique_source_aliases": len(aliases),
        "aliases_by_source": dict(sorted(aliases_by_source.items())),
        "canonical_source_rows": len(canonical_aliases),
        "canonical_source_rows_missing_from_alias_tab": len(missing_canonical_aliases),
        "supplemental_source_aliases": len(supplemental_aliases),
    })
    if validation["master_conflicts"]:
        validation["errors"].append("The wide crosswalk contains conflicting canonical vehicle values.")
    if validation["alias_rows_missing_master"]:
        validation["errors"].append("The source alias tab contains ePIDs that do not exist in the wide crosswalk.")
    if validation["alias_rows_with_invalid_source"]:
        validation["errors"].append("The source alias tab contains a source outside VCDB, ARI, or NADA.")
    if validation["alias_rows_missing_vehicle_fields"]:
        validation["errors"].append("The source alias tab contains rows missing year, make, or model.")
    if validation["canonical_source_rows_missing_from_alias_tab"]:
        validation["errors"].append("The source alias tab is missing a populated source mapping from the wide crosswalk.")
    validation["status"] = "passed" if not validation["errors"] else "failed"
    validation_path.write_text(json.dumps(validation, indent=2) + "\n", encoding="utf-8")
    if validation["status"] != "passed":
        raise ValueError("Vehicle mapping validation failed: " + " ".join(validation["errors"]))

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
    print(f"Validation: {validation['status']} -> {validation_path}")


if __name__ == "__main__":
    main()
