include_guard(GLOBAL)

if(BUILD_TESTING AND NOT MODULE_MOD-UNIT-WIDGET STREQUAL "disabled")
  set_property(GLOBAL APPEND PROPERTY ACORE_MODULE_TEST_SOURCES
    "${CMAKE_CURRENT_LIST_DIR}/tests/UnitWidgetStateTest.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/tests/UnitWidgetHttpTest.cpp")
  set_property(GLOBAL APPEND PROPERTY ACORE_MODULE_TEST_INCLUDES
    "${CMAKE_CURRENT_LIST_DIR}/src")
  if(MODULE_MOD-UNIT-WIDGET STREQUAL "dynamic")
    set_property(GLOBAL APPEND PROPERTY ACORE_MODULE_TEST_SOURCES
      "${CMAKE_CURRENT_LIST_DIR}/src/UnitWidgetState.cpp"
      "${CMAKE_CURRENT_LIST_DIR}/src/UnitWidgetHttp.cpp")
  endif()
endif()
