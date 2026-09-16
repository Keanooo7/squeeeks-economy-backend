// lib/features/weekly_schedule/domain/data_sources/task_library.dart

import 'package:cleaning/shared/enums/task_enums.dart';

class LibraryTask {
  final String id;
  final String title;
  final RoomType room;
  final int estimatedMinutes;
  final TaskFrequency frequency;

  /// Catalogue furniture ids this task is performed on, if any.
  ///
  /// Drives both directions of the cleaning flow: tapping a sink on the Home
  /// tab lists the tasks naming it, and starting a task from the weekly sheet
  /// flies the camera to a placed instance. Empty means the task has no
  /// physical anchor (floors, laundry, general tidying) — those open the
  /// completion screen directly.
  final List<String> furnitureIds;

  const LibraryTask({
    required this.id,
    required this.title,
    required this.room,
    required this.estimatedMinutes,
    required this.frequency,
    this.furnitureIds = const [],
  });
}

const List<LibraryTask> taskLibrary = [
  // Kitchen (5 tasks)
  LibraryTask(
    id: 'lib_kitchen_0',
    title: 'Wipe down counters',
    room: RoomType.kitchen,
    estimatedMinutes: 10,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['counter'],
  ),
  LibraryTask(
    id: 'lib_kitchen_1',
    title: 'Clean stovetop',
    room: RoomType.kitchen,
    estimatedMinutes: 15,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['stove'],
  ),
  LibraryTask(
    id: 'lib_kitchen_2',
    title: 'Empty and wipe microwave',
    room: RoomType.kitchen,
    estimatedMinutes: 10,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['microwave'],
  ),
  LibraryTask(
    id: 'lib_kitchen_3',
    title: 'Scrub sink',
    room: RoomType.kitchen,
    estimatedMinutes: 10,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['sink'],
  ),
  LibraryTask(
    id: 'lib_kitchen_4',
    title: 'Mop kitchen floor',
    room: RoomType.kitchen,
    estimatedMinutes: 20,
    frequency: TaskFrequency.weekly,
  ),

  // Bedroom (5 tasks)
  LibraryTask(
    id: 'lib_bedroom_0',
    title: 'Make bed',
    room: RoomType.bedroom,
    estimatedMinutes: 5,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['bed', 'bed_single', 'bunk_bed'],
  ),
  LibraryTask(
    id: 'lib_bedroom_1',
    title: 'Vacuum floor',
    room: RoomType.bedroom,
    estimatedMinutes: 15,
    frequency: TaskFrequency.weekly,
  ),
  LibraryTask(
    id: 'lib_bedroom_2',
    title: 'Dust furniture',
    room: RoomType.bedroom,
    estimatedMinutes: 15,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['dresser'],  // a dustable surface stands in for 'furniture' in general
  ),
  LibraryTask(
    id: 'lib_bedroom_3',
    title: 'Change bed sheets',
    room: RoomType.bedroom,
    estimatedMinutes: 20,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['bed', 'bed_single', 'bunk_bed'],
  ),
  LibraryTask(
    id: 'lib_bedroom_4',
    title: 'Clear nightstand',
    room: RoomType.bedroom,
    estimatedMinutes: 5,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['nightstand'],
  ),

  // Bathroom (5 tasks)
  LibraryTask(
    id: 'lib_bathroom_0',
    title: 'Scrub toilet',
    room: RoomType.bathroom,
    estimatedMinutes: 10,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['toilet'],
  ),
  LibraryTask(
    id: 'lib_bathroom_1',
    title: 'Wipe mirror and sink',
    room: RoomType.bathroom,
    estimatedMinutes: 10,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['sink'],
  ),
  LibraryTask(
    id: 'lib_bathroom_2',
    title: 'Clean shower/tub',
    room: RoomType.bathroom,
    estimatedMinutes: 20,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['bathtub', 'shower'],
  ),
  LibraryTask(
    id: 'lib_bathroom_3',
    title: 'Sweep and mop floor',
    room: RoomType.bathroom,
    estimatedMinutes: 15,
    frequency: TaskFrequency.weekly,
  ),
  LibraryTask(
    id: 'lib_bathroom_4',
    title: 'Empty trash and replace liner',
    room: RoomType.bathroom,
    estimatedMinutes: 5,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['bin'],  // W3-54 — the prop exists now
  ),

  // Living Room (5 tasks)
  LibraryTask(
    id: 'lib_livingroom_0',
    title: 'Vacuum rug',
    room: RoomType.livingRoom,
    estimatedMinutes: 15,
    frequency: TaskFrequency.weekly,
  ),
  LibraryTask(
    id: 'lib_livingroom_1',
    title: 'Dust shelves and TV',
    room: RoomType.livingRoom,
    estimatedMinutes: 15,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['bookshelf', 'tv_stand'],
  ),
  LibraryTask(
    id: 'lib_livingroom_2',
    title: 'Tidy cushions and throws',
    room: RoomType.livingRoom,
    estimatedMinutes: 5,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['sofa', 'armchair'],
  ),
  LibraryTask(
    id: 'lib_livingroom_3',
    title: 'Wipe down surfaces',
    room: RoomType.livingRoom,
    estimatedMinutes: 10,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['coffee_table', 'side_table'],
  ),
  LibraryTask(
    id: 'lib_livingroom_4',
    title: 'Clean windows and sills',
    room: RoomType.livingRoom,
    estimatedMinutes: 20,
    frequency: TaskFrequency.weekly,
  ),

  // Laundry Room (5 tasks)
  LibraryTask(
    id: 'lib_laundry_0',
    title: 'Run a load of laundry',
    room: RoomType.laundryRoom,
    // The washing machine exists as of the prop_washer_01 bake, so this row is
    // no longer propless and the weekly sheet can fly the camera to it.
    //
    // ⚠️ The note that used to say "ONLY this row … 'Clean lint trap' is a
    // DRYER and 'Fold and put away clothes' is a surface task; neither has a
    // prop" has been REPLACED, not amended: every laundry row below now carries
    // furnitureIds. Fold points at the wardrobe (where the clothes end up), and
    // the lint trap points at the WASHER — the project settled that it is part
    // of the machine rather than the dryer, which laundry_timer.dart states too
    // when it excludes the lint trap from being a wash cycle. A dryer prop does
    // now exist (#296), so if that call is ever revisited the asset is there.
    furnitureIds: ['washer'],
    estimatedMinutes: 10,
    frequency: TaskFrequency.weekly,
  ),
  LibraryTask(
    id: 'lib_laundry_1',
    title: 'Fold and put away clothes',
    room: RoomType.laundryRoom,
    estimatedMinutes: 20,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['wardrobe'],  // where the folded clothes end up
  ),
  LibraryTask(
    id: 'lib_laundry_2',
    title: 'Clean lint trap',
    room: RoomType.laundryRoom,
    estimatedMinutes: 5,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['washer'],  // the lint trap is part of the machine
  ),
  LibraryTask(
    id: 'lib_laundry_3',
    title: 'Wipe washer drum',
    room: RoomType.laundryRoom,
    estimatedMinutes: 10,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['washer'],  // the drum is the machine
  ),
  LibraryTask(
    id: 'lib_laundry_4',
    title: 'Declutter laundry area',
    room: RoomType.laundryRoom,
    estimatedMinutes: 15,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['washer'],  // the machine is the anchor of the area
  ),

  // Office (5 tasks)
  LibraryTask(
    id: 'lib_office_0',
    title: 'Clear desk surface',
    room: RoomType.office,
    estimatedMinutes: 10,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['desk'],
  ),
  LibraryTask(
    id: 'lib_office_1',
    title: 'Dust monitor and keyboard',
    room: RoomType.office,
    estimatedMinutes: 10,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['desk'],
  ),
  LibraryTask(
    id: 'lib_office_2',
    title: 'Cable management tidy-up',
    room: RoomType.office,
    estimatedMinutes: 15,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['desk'],  // the cables are under the desk
  ),
  LibraryTask(
    id: 'lib_office_3',
    title: 'Wipe down chair',
    room: RoomType.office,
    estimatedMinutes: 5,
    frequency: TaskFrequency.weekly,
    furnitureIds: ['office_chair'],
  ),
  LibraryTask(
    id: 'lib_office_4',
    title: 'Vacuum or sweep floor',
    room: RoomType.office,
    estimatedMinutes: 15,
    frequency: TaskFrequency.weekly,
  ),
];

Map<RoomType, List<LibraryTask>> get taskLibraryByRoom {
  final map = <RoomType, List<LibraryTask>>{};
  for (final task in taskLibrary) {
    map.putIfAbsent(task.room, () => []).add(task);
  }
  return map;
}
